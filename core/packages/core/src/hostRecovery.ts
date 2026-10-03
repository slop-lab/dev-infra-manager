import { recoverCiRunner } from "./ciRunnerRecovery.js";
import { MissingRecordError, UserError } from "./errors.js";
import { ensureGitea } from "./gitea.js";
import { ensureAptCache } from "./aptCache.js";
import { requireHostMirrorProvider } from "./hostMirrorProvider.js";
import { LifecycleState } from "./lifecycleState.js";
import type { HostLifecycleRecord, LifecycleOptions } from "./lifecycleTypes.js";
import { ensureRegistryCache } from "./registryCache.js";
import type { StreamingCommandRunner } from "./types.js";
import { setupWorkspace, showWorkspace, startWorkspace } from "./workspaceLifecycle.js";
import { readWorkspaceForOperation } from "./workspaceValidation.js";

export async function reconcileReadyHostManagedGit(
  runner: StreamingCommandRunner,
  options: LifecycleOptions
): Promise<void> {
  if (options.giteaConnection.kind === "external") return;
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireHostLifecycleLock();
  try {
    const current = await state.readHostLifecycle();
    if (current !== undefined && current.phase !== "ready") return;
    try {
      await state.readGiteaService();
    } catch (error) {
      if (error instanceof MissingRecordError) return;
      throw error;
    }
    await reconcileReadyManagedGit(runner, options, state, current ?? readyRecord());
  } finally {
    await release();
  }
}

export async function startHost(
  runner: StreamingCommandRunner,
  options: LifecycleOptions
): Promise<HostLifecycleRecord> {
  requireHostMirrorProvider(options.hostMirrorProvider);
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireHostLifecycleLock();
  try {
    const current = await state.readHostLifecycle();
    if (!current || current.phase === "ready") {
      const record = current ?? readyRecord();
      if (options.giteaConnection.kind === "managed") await reconcileReadyManagedGit(runner, options, state, record);
      await ensureRegistryCache(runner, options);
      await ensureAptCache(runner, options);
      return record;
    }
    for (const workspace of current.resumeWorkspaces) {
      await readWorkspaceForOperation(state, workspace, options.giteaConnection);
    }
    await ensureGitea(runner, options);
    await ensureRegistryCache(runner, options);
    await ensureAptCache(runner, options);
    const entryPhase = current.phase;
    let record: HostLifecycleRecord = { ...current, phase: "starting", updatedAt: new Date().toISOString() };
    delete record.error;
    await state.writeHostLifecycle(record);
    try {
      for (const container of record.resumeManagedContainers) {
        await startManagedContainer(runner, container);
      }
      for (const workspace of record.resumeWorkspaces) {
        await recoverWorkspace(runner, options, workspace);
      }
      while (record.restartCiRunners.length > 0) {
        const target = record.restartCiRunners[0];
        if (target === undefined) break;
        await recoverCiRunner(runner, options, {
          target,
          normalizeReady: entryPhase === "stopping"
        });
        record = { ...record, restartCiRunners: record.restartCiRunners.slice(1), updatedAt: new Date().toISOString() };
        await state.writeHostLifecycle(record);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = {
        ...record,
        phase: "error",
        error: message,
        updatedAt: new Date().toISOString()
      };
      await state.writeHostLifecycle(record);
      throw new UserError(message);
    }
    record = {
      ...record,
      phase: "ready",
      resumeWorkspaces: [],
      restartCiRunners: [],
      resumeManagedContainers: [],
      updatedAt: new Date().toISOString()
    };
    await state.writeHostLifecycle(record);
    return record;
  } finally {
    await release();
  }
}

async function reconcileReadyManagedGit(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  record: HostLifecycleRecord
): Promise<void> {
  try {
    await ensureGitea(runner, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await state.writeHostLifecycle({
      ...record,
      phase: "error",
      resumeWorkspaces: [],
      restartCiRunners: [],
      resumeManagedContainers: [],
      error: message,
      updatedAt: new Date().toISOString()
    });
    throw new UserError(message);
  }
}

async function recoverWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<void> {
  const workspace = await showWorkspace(runner, options, name);
  switch (workspace.phase) {
    case "ready":
      return;
    case "stopped":
      await startWorkspace(runner, options, name);
      return;
    case "setting-up":
    case "setup-error":
    case "error":
      await setupWorkspace(runner, options, name);
      return;
    case "creating":
      throw new UserError(`workspace '${name}' is still creating and cannot be recovered by host start`);
    case "discarding":
      throw new UserError(`workspace '${name}' discard is incomplete; retry workspace discard`);
    default:
      return assertNeverPhase(workspace.phase, "workspace");
  }
}

async function startManagedContainer(runner: StreamingCommandRunner, name: string): Promise<void> {
  const inspect = await runner.run("docker", [
    "container", "inspect", name, "--format", "{{.Id}}|{{index .Config.Labels \"dim.managed\"}}|{{index .Config.Labels \"dim.owner\"}}|{{index .Config.Labels \"dim.resource\"}}|{{index .Config.Labels \"dim.resource-id\"}}|{{.State.Running}}"
  ]);
  if (inspect.exitCode !== 0) throw new UserError(`cannot inspect '${name}': ${inspect.stderr.trim()}`);
  const [containerId, managed, owner, resource, resourceId, running] = inspect.stdout.trim().split("|");
  if (!containerId || managed !== "true" || owner !== "dim" || !resource || !resourceId) {
    throw new UserError(`Docker resource '${name}' is not managed by DIM`);
  }
  if (running === "true") return;
  const started = await runner.run("docker", ["start", containerId]);
  if (started.exitCode !== 0) throw new UserError(`failed to start '${name}': ${started.stderr.trim()}`);
}

function readyRecord(): HostLifecycleRecord {
  return {
    schemaVersion: 2,
    phase: "ready",
    resumeWorkspaces: [],
    restartCiRunners: [],
    resumeManagedContainers: [],
    updatedAt: new Date(0).toISOString()
  };
}

function assertNeverPhase(phase: never, subject: string): never {
  throw new UserError(`unsupported ${subject} phase: ${String(phase)}`);
}
