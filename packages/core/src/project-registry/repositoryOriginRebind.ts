import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "../errors.js";
import { ensureGitea } from "../gitea.js";
import { LifecycleState, validateLifecycleName } from "../lifecycleState.js";
import type {
  LifecycleOptions,
  ProjectRecord,
  ProjectRepositoryRecord,
  RepositoryConnection
} from "../lifecycleTypes.js";
import {
  resolveRepositoryConnection,
  validateRepositorySet,
  type RepositorySet
} from "../repositorySet.js";
import type { CommandResult, CommandRunner } from "../types.js";
import { assertReadyProject, gitCredentialEnvironment, replaceRepository } from "./helpers.js";

export type RebindProjectRootOriginInput = {
  readonly project: string;
  readonly alias: string;
  readonly expectedOldOriginDigest: string;
  readonly expectedOriginTip: string;
  readonly approved: boolean;
  readonly repositorySet: RepositorySet;
};

export async function rebindProjectRootOrigin(
  runner: CommandRunner,
  options: LifecycleOptions,
  input: RebindProjectRootOriginInput
): Promise<ProjectRepositoryRecord> {
  if (!input.approved) throw new UserError("root origin rebind requires explicit approval");
  if (!/^[0-9a-f]{64}$/.test(input.expectedOldOriginDigest)) {
    throw new UserError("expected old origin digest must be exactly 64 lowercase hexadecimal characters");
  }
  if (!/^[0-9a-f]{40}$/.test(input.expectedOriginTip)) {
    throw new UserError("expected origin tip must be exactly 40 lowercase hexadecimal characters");
  }
  const projectName = validateLifecycleName(input.project, "project");
  const alias = validateLifecycleName(input.alias, "repo alias");
  const set = validateRepositorySet(input.repositorySet);
  const entry = set.repositories[alias];
  if (entry === undefined) throw new UserError(`repository set has no repository '${alias}'`);
  const requested = resolveRepositoryConnection(set, alias);
  if (requested === undefined) throw new UserError("root origin rebind requires an external origin");
  assertSafeRebindUrl(requested.url);

  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireProjectLock(projectName);
  try {
    const project = await state.readProject(projectName);
    assertReadyProject(project);
    const repository = assertRebindTarget(project, alias, entry, requested);
    const previousConnection = repository.connections.find(({ name }) => name === "origin");
    if (previousConnection === undefined) throw new UserError(`repo '${projectName}/${alias}' has no existing origin`);
    if (repositoryOriginDigest(previousConnection.url) !== input.expectedOldOriginDigest) {
      throw new UserError("recorded root origin changed after the reviewed rebind plan");
    }
    if (previousConnection.url === requested.url) throw new UserError(`repo '${projectName}/${alias}' already uses the requested origin`);

    const credentials = await ensureGitea(runner, options);
    const managedTip = await advertisedTip({
      runner, url: repository.hostUrl, ref: project.rootRef,
      env: gitCredentialEnvironment(credentials), label: "managed root"
    });
    const externalTip = await advertisedTip({
      runner, url: requested.url, ref: project.rootRef, env: process.env, label: "requested origin"
    });
    if (externalTip !== input.expectedOriginTip) {
      throw new UserError("requested origin does not advertise the expected origin tip");
    }
    await assertAncestor({
      runner, externalUrl: requested.url, ref: project.rootRef,
      managedTip, expectedTip: input.expectedOriginTip
    });
    const currentManagedTip = await advertisedTip({
      runner, url: repository.hostUrl, ref: project.rootRef,
      env: gitCredentialEnvironment(credentials), label: "managed root"
    });
    if (currentManagedTip !== managedTip) throw new UserError("managed root changed during origin rebind verification");
    const currentExternalTip = await advertisedTip({
      runner, url: requested.url, ref: project.rootRef, env: process.env, label: "requested origin"
    });
    if (currentExternalTip !== input.expectedOriginTip) {
      throw new UserError("requested origin changed during origin rebind verification");
    }

    const currentProject = await state.readProject(projectName);
    const currentRepository = currentProject.repositories.find((candidate) => candidate.alias === alias);
    const currentConnection = currentRepository?.connections.find(({ name }) => name === "origin");
    if (currentConnection === undefined || repositoryOriginDigest(currentConnection.url) !== input.expectedOldOriginDigest) {
      throw new UserError("recorded root origin changed during origin rebind verification");
    }
    const updated: ProjectRepositoryRecord = {
      ...repository,
      connections: [{ name: "origin", ...requested }],
      updatedAt: new Date().toISOString()
    };
    await state.writeProject(replaceRepository(currentProject, updated));
    return updated;
  } finally {
    await release();
  }
}

export function repositoryOriginDigest(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function assertRebindTarget(
  project: ProjectRecord,
  alias: string,
  entry: RepositorySet["repositories"][string],
  requested: Omit<RepositoryConnection, "name">
): ProjectRepositoryRecord {
  if (project.rootRepositoryAlias !== alias || !entry.root) {
    throw new UserError("origin rebind is allowed only for the existing project root");
  }
  const repository = project.repositories.find((candidate) => candidate.alias === alias);
  if (repository === undefined || repository.phase !== "ready") throw new UserError(`root repo '${project.name}/${alias}' is not ready`);
  if (repository.protectionPhase !== "applied") throw new UserError(`root repo '${project.name}/${alias}' protection is not applied`);
  if (project.rootRef === undefined || !project.rootRef.startsWith("refs/heads/")
    || repository.ref !== project.rootRef || entry.ref !== project.rootRef) {
    throw new UserError("root origin rebind requires an unchanged concrete root ref");
  }
  const branch = project.rootRef.slice("refs/heads/".length);
  if (!repository.protectedPatterns.some((pattern) => matchesProtectionPattern(branch, pattern))) {
    throw new UserError("root origin rebind requires the root branch to remain protected");
  }
  const existing = repository.connections.find(({ name }) => name === "origin");
  const samePolicy = JSON.stringify({
    refNamespace: existing?.refNamespace,
    publishBranches: existing?.publishBranches ?? {}
  }) === JSON.stringify({
    refNamespace: requested.refNamespace,
    publishBranches: requested.publishBranches ?? {}
  });
  if (!samePolicy
    || JSON.stringify(repository.protectedPatterns) !== JSON.stringify(entry.protectedPatterns)
    || JSON.stringify(repository.forcePushBlockedPatterns ?? []) !== JSON.stringify(entry.forcePushBlockedPatterns)) {
    throw new UserError("root origin rebind cannot change ref mapping or protection policy");
  }
  return repository;
}

function matchesProtectionPattern(branch: string, pattern: string): boolean {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${expression}$`).test(branch);
}

function assertSafeRebindUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError("root origin rebind requires an absolute HTTPS Git URL");
  }
  if (url.protocol !== "https:" || url.hostname.length === 0 || url.username || url.password
    || url.search.length > 0 || url.hash.length > 0) {
    const reason = url.username || url.password ? " and must not contain credentials" : "";
    throw new UserError(`root origin rebind requires an absolute HTTPS Git URL${reason}`);
  }
}

async function advertisedTip(input: {
  readonly runner: CommandRunner;
  readonly url: string;
  readonly ref: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly label: string;
}): Promise<string> {
  const { runner, url, ref, env, label } = input;
  if (ref === undefined || !ref.startsWith("refs/heads/")) {
    throw new UserError("root origin rebind requires a concrete branch root ref");
  }
  const result = await runner.run("git", ["ls-remote", "--exit-code", url, ref], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0" }
  });
  if (result.exitCode !== 0) throw gitFailure(`read ${label} tip`, result);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const match = lines.length === 1 ? lines[0]?.match(/^([0-9a-f]{40})\s+(refs\/heads\/[A-Za-z0-9._/-]+)$/) : undefined;
  if (match?.[1] === undefined || match[2] !== ref) {
    throw new UserError(`${label} returned an invalid Git branch tip`);
  }
  return match[1];
}

async function assertAncestor(input: {
  readonly runner: CommandRunner;
  readonly externalUrl: string;
  readonly ref: string | undefined;
  readonly managedTip: string;
  readonly expectedTip: string;
}): Promise<void> {
  const { runner, externalUrl, ref, managedTip, expectedTip } = input;
  if (ref === undefined) throw new UserError("root origin rebind requires a concrete branch root ref");
  const temporary = await mkdtemp(join(tmpdir(), "dim-origin-rebind-"));
  const repository = join(temporary, "verify.git");
  try {
    await successfulGit(runner, ["init", "--bare", repository], "initialize origin verification");
    await successfulGit(
      runner,
      ["--git-dir", repository, "fetch", "--no-tags", externalUrl, expectedTip],
      "fetch expected origin tip"
    );
    const ancestry = await runner.run("git", [
      "--git-dir", repository, "merge-base", "--is-ancestor", managedTip, expectedTip
    ]);
    if (ancestry.exitCode !== 0) throw new UserError("managed protected-root tip is not an ancestor of the expected origin tip");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function successfulGit(runner: CommandRunner, args: string[], action: string): Promise<void> {
  const result = await runner.run("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.exitCode !== 0) throw gitFailure(action, result);
}

function gitFailure(action: string, result: Pick<CommandResult, "stderr" | "stdout">): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}
