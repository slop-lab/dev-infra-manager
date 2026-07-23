import { realpath } from "node:fs/promises";
import { UserError } from "./errors.js";
import { ensureGitea, giteaHostCloneUrl, giteaInternalCloneUrl, giteaRequest } from "./gitea.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { LifecycleOptions, RepoRecord } from "./lifecycleTypes.js";
import type { CommandRunner } from "./types.js";

export async function registerRepo(
  runner: CommandRunner,
  options: LifecycleOptions,
  input: { name: string; sourcePath: string; protectedPatterns: string[] }
): Promise<RepoRecord> {
  const name = validateLifecycleName(input.name, "repo");
  const sourcePath = await validateBareRepo(runner, input.sourcePath);
  const state = new LifecycleState(options.stateRoot);
  const now = new Date().toISOString();
  const record: RepoRecord = {
    name,
    owner: options.giteaAdminUsername,
    cloneUrl: giteaInternalCloneUrl(options.giteaAdminUsername, name),
    sourcePath,
    phase: "importing",
    protectedPatterns: input.protectedPatterns,
    registeredAt: now,
    updatedAt: now
  };

  let current: RepoRecord;
  let resuming = false;
  try {
    current = await state.readRepo(name);
    if (current.phase === "ready") {
      throw new UserError(`repo '${name}' is already registered`);
    }
    if (current.sourcePath !== sourcePath) {
      throw new UserError(`repo '${name}' has an incomplete import from a different source`);
    }
    current = { ...current, phase: "importing", updatedAt: now };
    resuming = true;
    delete current.error;
    await state.writeRepo(current);
  } catch (error) {
    if (!(error instanceof UserError) || !error.message.includes("not registered")) throw error;
    await state.claimRepo(record);
    current = record;
  }

  try {
    const credentials = await ensureGitea(runner, options);
    current = {
      ...current,
      owner: credentials.adminUsername,
      cloneUrl: giteaInternalCloneUrl(credentials.adminUsername, name),
      updatedAt: new Date().toISOString()
    };
    await state.writeRepo(current);
    const created = await ensureRemoteRepo(options, credentials, name);
    if (!created && !resuming) {
      const repository = await giteaRequest(options, credentials, "GET", `/repos/${credentials.adminUsername}/${name}`);
      if (!repository.ok) throw await apiError("inspect existing Gitea repository", repository);
      const detail = await repository.json() as { empty?: boolean };
      if (detail.empty !== true) {
        throw new UserError(`Gitea repository '${name}' already exists and is not empty`);
      }
    }
    await importRefs(runner, options, credentials, sourcePath, name, resuming);
    await grantWriter(options, credentials, name);
    for (const pattern of input.protectedPatterns) {
      await protectBranch(options, credentials, name, pattern);
    }
    current = { ...current, phase: "ready", updatedAt: new Date().toISOString() };
    delete current.error;
    await state.writeRepo(current);
    return current;
  } catch (error) {
    current = {
      ...current,
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    };
    await state.writeRepo(current);
    throw error;
  }
}

export async function listRegisteredRepos(options: LifecycleOptions): Promise<RepoRecord[]> {
  return new LifecycleState(options.stateRoot).listRepos();
}

export async function showRegisteredRepo(options: LifecycleOptions, name: string): Promise<RepoRecord> {
  return new LifecycleState(options.stateRoot).readRepo(validateLifecycleName(name, "repo"));
}

async function validateBareRepo(runner: CommandRunner, inputPath: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(inputPath);
  } catch (error) {
    throw new UserError(`bare repository path is not accessible: ${(error as Error).message}`);
  }
  const result = await runner.run("git", ["--git-dir", canonical, "rev-parse", "--is-bare-repository"]);
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new UserError(`not a bare Git repository: ${canonical}`);
  }
  return canonical;
}

async function ensureRemoteRepo(
  options: LifecycleOptions,
  credentials: Awaited<ReturnType<typeof ensureGitea>>,
  name: string
): Promise<boolean> {
  const response = await giteaRequest(options, credentials, "POST", `/admin/users/${credentials.adminUsername}/repos`, {
    name,
    private: false,
    auto_init: false
  });
  if (response.ok) return true;
  if (response.status === 409 || response.status === 422) return false;
  throw await apiError("create Gitea repository", response);
}

async function importRefs(
  runner: CommandRunner,
  options: LifecycleOptions,
  credentials: Awaited<ReturnType<typeof ensureGitea>>,
  sourcePath: string,
  name: string,
  force: boolean
): Promise<void> {
  const refs = await runner.run("git", [
    "--git-dir", sourcePath,
    "for-each-ref", "--format=%(refname)",
    "refs/heads", "refs/tags"
  ]);
  if (refs.exitCode !== 0) throw new UserError(`failed to inspect repository '${name}': ${refs.stderr.trim()}`);
  if (refs.stdout.trim().length === 0) return;
  const helper = "!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DIM_GIT_USERNAME: credentials.adminUsername,
    DIM_GIT_TOKEN: credentials.adminPassword,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: helper
  };
  const result = await runner.run("git", [
    "--git-dir", sourcePath,
    "push", giteaHostCloneUrl(options, credentials.adminUsername, name),
    `${force ? "+" : ""}refs/heads/*:refs/heads/*`,
    `${force ? "+" : ""}refs/tags/*:refs/tags/*`
  ], { env });
  if (result.exitCode !== 0) {
    throw new UserError(`failed to import repository '${name}': ${result.stderr.trim()}`);
  }
}

async function grantWriter(
  options: LifecycleOptions,
  credentials: Awaited<ReturnType<typeof ensureGitea>>,
  name: string
): Promise<void> {
  const response = await giteaRequest(
    options,
    credentials,
    "PUT",
    `/repos/${credentials.adminUsername}/${name}/collaborators/${credentials.writerUsername}`,
    { permission: "write" }
  );
  if (!response.ok && response.status !== 204) throw await apiError("grant workspace writer access", response);
}

async function protectBranch(
  options: LifecycleOptions,
  credentials: Awaited<ReturnType<typeof ensureGitea>>,
  name: string,
  pattern: string
): Promise<void> {
  const response = await giteaRequest(options, credentials, "POST", `/repos/${credentials.adminUsername}/${name}/branch_protections`, {
    branch_name: pattern,
    enable_push: false,
    enable_merge_whitelist: true,
    merge_whitelist_usernames: [credentials.adminUsername],
    required_approvals: 1,
    block_on_rejected_reviews: true,
    dismiss_stale_approvals: true
  });
  if (response.ok || response.status === 409 || response.status === 422) return;
  throw await apiError(`protect branch pattern '${pattern}'`, response);
}

async function apiError(action: string, response: Response): Promise<UserError> {
  return new UserError(`failed to ${action}: Gitea API ${response.status}: ${(await response.text()).trim()}`);
}
