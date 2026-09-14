import { UserError } from "./errors.js";
import { ensureGitea } from "./gitea.js";
import { LifecycleState } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import type { ProtectedRootSnapshot } from "./protectedRootSnapshot.js";
import type { StreamingCommandRunner } from "./types.js";
import {
  resolveRepositorySnapshot,
  writeProjectManifest
} from "./workspaceRepositorySnapshot.js";
import {
  WORKSPACE_USER,
  type WorkspacePublicationTarget
} from "./workspaceLifecycleTypes.js";
import {
  commandError,
  projectCommand,
  rootBranch
} from "./workspaceProjectCommands.js";

export type ResolvedWorkspacePublicationTarget = ProtectedRootSnapshot & {
  readonly repositorySnapshot: WorkspaceRecord["repositorySnapshot"];
};

export async function ensureClone(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  cloneUrl: string
): Promise<void> {
  const existing = await runner.run("docker", [
    "exec", "--user", WORKSPACE_USER, record.containerName,
    "git", "-C", record.projectPath, "rev-parse", "--git-dir"
  ]);
  if (existing.exitCode === 0) return;
  const parent = record.projectPath.slice(0, record.projectPath.lastIndexOf("/")) || "/workspace";
  const directory = await runner.run("docker", ["exec", "--user", WORKSPACE_USER, record.containerName, "mkdir", "-p", parent]);
  if (directory.exitCode !== 0) throw commandError("prepare project directory", directory);
  const clone = await runner.run("docker", [
    "exec", "--user", WORKSPACE_USER, record.containerName,
    "git", "clone", "--no-checkout", cloneUrl, record.projectPath
  ]);
  if (clone.exitCode !== 0) throw commandError(`clone project '${record.projectName}'`, clone);
  const fetch = await projectCommand(runner, record, ["git", "fetch", "--no-write-fetch-head", "origin", record.rootCommit]);
  if (fetch.exitCode !== 0) throw commandError(`fetch root commit '${record.rootCommit}'`, fetch);
  const checkout = await projectCommand(runner, record, [
    "git", "switch", "--force-create", rootBranch(record.rootRef), record.rootCommit
  ]);
  if (checkout.exitCode !== 0) throw commandError(`check out root commit '${record.rootCommit}'`, checkout);
}

export async function planFastForwardRoot(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  target: Pick<WorkspaceRecord, "rootRef" | "rootCommit">
): Promise<void> {
  const status = await projectCommand(runner, record, ["git", "status", "--porcelain"]);
  if (status.exitCode !== 0) throw commandError("inspect project Git status", status);
  if (status.stdout.trim()) {
    throw new UserError(
      `workspace '${record.name}' has uncommitted project changes; commit or remove them, or run `
      + `dim workspace align ${record.name} --reset --yes to discard them`
    );
  }
  const fetch = await projectCommand(runner, record, ["git", "fetch", "--no-write-fetch-head", "origin", target.rootCommit]);
  if (fetch.exitCode !== 0) throw commandError(`fetch root ref '${target.rootRef}'`, fetch);
  const behind = await projectCommand(runner, record, ["git", "merge-base", "--is-ancestor", "HEAD", target.rootCommit]);
  if (behind.exitCode !== 0 && behind.exitCode !== 1) {
    throw commandError(`check fast-forward to root ref '${record.rootRef}'`, behind);
  }
  const ahead = behind.exitCode === 1
    ? await projectCommand(runner, record, ["git", "merge-base", "--is-ancestor", target.rootCommit, "HEAD"])
    : undefined;
  if (ahead !== undefined && ahead.exitCode === 1) {
    throw new UserError(
      `workspace '${record.name}' cannot fast-forward to '${record.rootRef}'; run `
      + `dim workspace align ${record.name} --reset --yes to discard divergent local commits`
    );
  }
  if (ahead !== undefined && ahead.exitCode !== 0) {
    throw commandError(`check local root compatibility with '${record.rootRef}'`, ahead);
  }
}

async function applyFastForwardRoot(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  target: Pick<ProtectedRootSnapshot, "rootRef" | "rootCommit">
): Promise<void> {
  const merge = await projectCommand(runner, record, ["git", "merge", "--ff-only", target.rootCommit]);
  if (merge.exitCode !== 0) throw commandError(`fast-forward root ref '${target.rootRef}'`, merge);
}

export async function resolveWorkspacePublication(input: {
  readonly runner: StreamingCommandRunner;
  readonly options: LifecycleOptions;
  readonly record: WorkspaceRecord;
  readonly target: ProtectedRootSnapshot;
}): Promise<ResolvedWorkspacePublicationTarget> {
  const credentials = await ensureGitea(input.runner, input.options);
  const repositorySnapshot = await resolveRepositorySnapshot(
    input.runner,
    {
      rootRepositoryAlias: input.target.repository.alias,
      rootRequestedRef: input.target.rootRequestedRef,
      rootRef: input.target.rootRef,
      rootCommit: input.target.rootCommit,
      ...(input.record.repositoryRefOverrides === undefined
        ? {}
        : { repositoryRefOverrides: input.record.repositoryRefOverrides })
    },
    input.target.project,
    credentials
  );
  return { ...input.target, repositorySnapshot };
}

async function recordSelectedRoot(
  state: LifecycleState,
  record: WorkspaceRecord,
  target: WorkspacePublicationTarget
): Promise<WorkspaceRecord> {
  const updating = {
    ...record,
    rootRef: target.rootRef,
    rootCommit: target.rootCommit,
    rootSnapshotPath: target.rootSnapshotPath,
    repositorySnapshot: target.repositorySnapshot,
    phase: "setting-up" as const,
    updatedAt: new Date().toISOString()
  };
  delete updating.error;
  await state.writeWorkspace(updating);
  return updating;
}

export async function applySelectedRoot(input: {
  readonly runner: StreamingCommandRunner;
  readonly state: LifecycleState;
  readonly record: WorkspaceRecord;
  readonly target: WorkspacePublicationTarget;
  readonly containerId: string;
}): Promise<WorkspaceRecord> {
  const updating = await recordSelectedRoot(input.state, input.record, input.target);
  const runtimeRecord = { ...input.record, containerName: input.containerId };
  try {
    await applyFastForwardRoot(input.runner, runtimeRecord, input.target);
    await writeProjectManifest(input.runner, { ...updating, containerName: runtimeRecord.containerName });
    return updating;
  } catch (error) {
    await input.state.writeWorkspace({
      ...updating,
      phase: "setup-error",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    });
    throw error;
  }
}
