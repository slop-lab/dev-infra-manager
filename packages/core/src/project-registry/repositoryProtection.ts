import { UserError } from "../errors.js";
import { ensureGitea, giteaRequest } from "../gitea.js";
import type { GiteaConnection } from "../gitea.js";
import { LifecycleState, validateLifecycleName } from "../lifecycleState.js";
import type { GiteaCredentials, HostGitCredential, LifecycleOptions, ProjectRecord, ProjectRepositoryRecord } from "../lifecycleTypes.js";
import type { CommandRunner } from "../types.js";
import { apiError, commandError, gitCredentialEnvironment, replaceRepository } from "./helpers.js";
import { grantRepositoryUsers } from "./repositoryMembership.js";

export async function applyProjectRepositoryProtection(
  runner: CommandRunner,
  options: LifecycleOptions,
  projectNameInput: string,
  aliasInput: string
): Promise<ProjectRepositoryRecord> {
  const projectName = validateLifecycleName(projectNameInput, "project");
  const alias = validateLifecycleName(aliasInput, "repo alias");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireProjectLock(projectName);
  try {
    let project = await state.readProject(projectName);
    let repo = project.repositories.find((candidate) => candidate.alias === alias);
    if (!repo) throw new UserError(`repo '${projectName}/${alias}' not found`);
    if (repo.phase !== "ready") throw new UserError(`repo '${projectName}/${alias}' is not ready`);
    const credentials = await ensureGitea(runner, options);
    await protectProjectRepository(runner, credentials, { project, repository: repo });
    repo = { ...repo, protectionPhase: "applied", updatedAt: new Date().toISOString() };
    project = replaceRepository(project, repo);
    await state.writeProject(project);
    return repo;
  } finally {
    await release();
  }
}

export async function protectProjectRepository(
  runner: CommandRunner,
  credentials: GiteaConnection,
  target: { readonly project: ProjectRecord; readonly repository: ProjectRepositoryRecord }
): Promise<void> {
  const { project, repository } = target;
  if (project.rootRepositoryAlias === repository.alias && project.rootRef === undefined) {
    await ensureSingleBranchHead(runner, credentials, project.gitNamespace, repository);
  }
  await applyProtectionPatterns(credentials, project.gitNamespace, repository);
}

async function ensureSingleBranchHead(
  runner: CommandRunner,
  credentials: GiteaConnection,
  organization: string,
  repo: ProjectRepositoryRecord
): Promise<void> {
  const repository = await giteaRequest(credentials, "GET", `/repos/${organization}/${repo.alias}`);
  if (!repository.ok) throw await apiError(`inspect repo '${organization}/${repo.alias}'`, repository);
  const metadata = await repository.json() as { default_branch?: string };
  const listed = await runner.run("git", ["ls-remote", "--heads", repo.hostUrl], {
    env: gitCredentialEnvironment(credentials)
  });
  if (listed.exitCode !== 0) throw commandError(`list branches for '${organization}/${repo.alias}'`, listed);
  const names = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/\srefs\/heads\/(.+)$/)?.[1])
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  if (metadata.default_branch && names.includes(metadata.default_branch)) return;
  if (names.length !== 1) return;
  const updated = await giteaRequest(credentials, "PATCH", `/repos/${organization}/${repo.alias}`, {
    default_branch: names[0]
  });
  if (!updated.ok) throw await apiError(`set root HEAD for '${organization}/${repo.alias}'`, updated);
}

async function applyProtectionPatterns(
  credentials: GiteaConnection,
  organization: string,
  repo: ProjectRepositoryRecord
): Promise<void> {
  for (const pattern of repo.protectedPatterns) {
    await protectBranch(credentials, organization, repo.alias, pattern, "reviewed");
  }
  for (const pattern of repo.forcePushBlockedPatterns ?? []) {
    if (!repo.protectedPatterns.includes(pattern)) {
      await protectBranch(credentials, organization, repo.alias, pattern, "no-force-push");
    }
  }
}

export async function prepareHostGitCredential(
  runner: CommandRunner,
  options: LifecycleOptions
): Promise<HostGitCredential> {
  const credentials = await ensureGitea(runner, options);
  const projects = await new LifecycleState(options.stateRoot).listProjects();
  for (const project of projects.filter((candidate) => candidate.phase === "ready")) {
    for (const repo of project.repositories.filter((candidate) => candidate.phase === "ready")) {
      await grantRepositoryUsers(credentials, project.gitNamespace, repo.alias);
      await applyProtectionPatterns(credentials, project.gitNamespace, repo);
    }
  }
  return {
    username: credentials.maintainerUsername,
    password: credentials.maintainerPassword,
    baseUrl: credentials.hostBaseUrl
  };
}

async function protectBranch(
  credentials: GiteaConnection,
  organization: string,
  alias: string,
  pattern: string,
  policy: "reviewed" | "no-force-push"
): Promise<void> {
  const protection = branchProtectionOptions(credentials, policy);
  const updated = await giteaRequest(
    credentials,
    "PATCH",
    `/repos/${organization}/${alias}/branch_protections/${encodeURIComponent(pattern)}`,
    protection
  );
  if (updated.ok) return;
  if (updated.status !== 404) throw await apiError(`update branch protection pattern '${pattern}'`, updated);
  const created = await giteaRequest(
    credentials,
    "POST",
    `/repos/${organization}/${alias}/branch_protections`,
    { branch_name: pattern, ...protection }
  );
  if (!created.ok && created.status !== 409 && created.status !== 422) {
    throw await apiError(`protect branch pattern '${pattern}'`, created);
  }
}

export function branchProtectionOptions(
  credentials: Pick<GiteaCredentials, "adminUsername" | "maintainerUsername">,
  policy: "reviewed" | "no-force-push" = "reviewed"
): Record<string, unknown> {
  if (policy === "no-force-push") {
    return {
      enable_push: true,
      enable_push_whitelist: false,
      push_whitelist_usernames: [],
      push_whitelist_teams: [],
      enable_force_push: false,
      enable_merge_whitelist: false,
      merge_whitelist_usernames: [],
      merge_whitelist_teams: [],
      required_approvals: 0,
      block_on_rejected_reviews: false,
      dismiss_stale_approvals: false,
      block_admin_merge_override: false
    };
  }
  return {
    enable_push: true,
    enable_push_whitelist: true,
    push_whitelist_usernames: [credentials.maintainerUsername],
    push_whitelist_teams: [],
    push_whitelist_deploy_keys: false,
    enable_force_push: false,
    enable_force_push_allowlist: false,
    force_push_allowlist_usernames: [],
    force_push_allowlist_teams: [],
    force_push_allowlist_deploy_keys: false,
    enable_merge_whitelist: true,
    merge_whitelist_usernames: [credentials.adminUsername],
    merge_whitelist_teams: ["Owners"],
    enable_bypass_allowlist: false,
    bypass_allowlist_usernames: [],
    bypass_allowlist_teams: [],
    required_approvals: 1,
    enable_approvals_whitelist: true,
    approvals_whitelist_username: [],
    approvals_whitelist_teams: ["Owners"],
    block_on_rejected_reviews: true,
    block_on_official_review_requests: true,
    dismiss_stale_approvals: true,
    ignore_stale_approvals: false,
    unprotected_file_patterns: "",
    protected_file_patterns: "",
    block_admin_merge_override: true
  };
}
