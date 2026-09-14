import { stopCiRunner } from "./ciRunner.js";
import { UserError } from "./errors.js";
import { GITEA_CONTAINER } from "./gitea.js";
import { LifecycleState } from "./lifecycleState.js";
import type { HostLifecycleRecord, LifecycleOptions } from "./lifecycleTypes.js";
import { REGISTRY_CACHE_CONTAINER } from "./registryCache.js";
import type { StreamingCommandRunner } from "./types.js";
import { listWorkspaces, stopWorkspace } from "./workspaceLifecycle.js";

export async function shutdownHost(
  runner: StreamingCommandRunner,
  options: LifecycleOptions
): Promise<HostLifecycleRecord> {
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireHostLifecycleLock();
  try {
    const current = await state.readHostLifecycle();
    if (current && current.phase !== "ready") {
      throw new UserError(`DIM host is already ${current.phase}; run dim host start to recover it`);
    }
    const resumeWorkspaces = (await listWorkspaces(runner, options))
      .filter((workspace) => workspace.phase === "ready")
      .map((workspace) => workspace.name);
    const ciRunners = await state.listCiRunners();
    const restartCiRunners = ciRunners
      .filter((record) => record.executor.phase === "ready")
      .map((record) => ({ project: record.projectName, name: record.name }));
    const workspaceContainers = new Set((await state.listWorkspaces()).map((workspace) => workspace.containerName));
    const runnerContainers = new Set(ciRunners.map((ciRunner) => ciRunner.executor.kind === "sysbox"
      ? ciRunner.executor.containerName
      : ciRunner.executor.supervisorName));
    const resumeManagedContainers = (await listRunningManagedContainers(runner)).filter((name) =>
      name !== GITEA_CONTAINER
      && name !== REGISTRY_CACHE_CONTAINER
      && !workspaceContainers.has(name)
      && !runnerContainers.has(name));
    let record: HostLifecycleRecord = {
      schemaVersion: 2,
      phase: "stopping",
      resumeWorkspaces,
      restartCiRunners,
      resumeManagedContainers,
      updatedAt: new Date().toISOString()
    };
    await state.writeHostLifecycle(record);
    const errors: string[] = [];
    for (const target of restartCiRunners) {
      await attempt(errors, `stop CI runner '${target.project}/${target.name}'`, () =>
        stopCiRunner(runner, options, target.project, target.name));
    }
    for (const workspace of resumeWorkspaces) {
      await attempt(errors, `stop workspace '${workspace}'`, () => stopWorkspace(runner, options, workspace));
    }
    for (const container of resumeManagedContainers) {
      await attempt(errors, `stop managed container '${container}'`, () => stopManagedContainer(runner, container));
    }
    await attempt(errors, "stop registry cache", () => stopManagedContainer(runner, REGISTRY_CACHE_CONTAINER));
    await attempt(errors, "stop Gitea", () => stopManagedContainer(runner, GITEA_CONTAINER));
    record = {
      ...record,
      phase: errors.length === 0 ? "stopped" : "error",
      updatedAt: new Date().toISOString(),
      ...(errors.length === 0 ? {} : { error: errors.join("; ") })
    };
    await state.writeHostLifecycle(record);
    if (errors.length > 0) throw new UserError(errors.join("; "));
    return record;
  } finally {
    await release();
  }
}

async function stopManagedContainer(runner: StreamingCommandRunner, name: string): Promise<void> {
  const inspect = await runner.run("docker", [
    "container", "inspect", name, "--format", "{{.Id}}|{{index .Config.Labels \"dim.managed\"}}|{{.State.Running}}"
  ]);
  if (inspect.exitCode !== 0) {
    if (/no such (?:container|object)/i.test(inspect.stderr)) return;
    throw new UserError(`cannot inspect '${name}': ${inspect.stderr.trim()}`);
  }
  const [containerId, managed, running] = inspect.stdout.trim().split("|");
  if (!containerId || managed !== "true") throw new UserError(`Docker resource '${name}' is not managed by DIM`);
  if (running !== "true") return;
  const stopped = await runner.run("docker", ["stop", containerId]);
  if (stopped.exitCode !== 0) throw new UserError(`failed to stop '${name}': ${stopped.stderr.trim()}`);
}

async function listRunningManagedContainers(runner: StreamingCommandRunner): Promise<string[]> {
  const listed = await runner.run("docker", [
    "container", "ls", "--filter", "label=dim.managed=true", "--format", "{{.Names}}"
  ]);
  if (listed.exitCode !== 0) throw new UserError(`cannot list DIM-managed containers: ${listed.stderr.trim()}`);
  return listed.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean).sort();
}

async function attempt(errors: string[], action: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(`${action}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
