import { stopCiRunner } from "./ciRunner.js";
import { UserError } from "./errors.js";
import { GITEA_CONTAINER } from "./gitea.js";
import { inspectGiteaContainer } from "./giteaContainer.js";
import { LifecycleState } from "./lifecycleState.js";
import type { HostLifecycleRecord, LifecycleOptions } from "./lifecycleTypes.js";
import { REGISTRY_CACHE_CONTAINER } from "./registryCache.js";
import { APT_CACHE_CONTAINER } from "./aptCache.js";
import {
  hostMirrorInspection,
  type HostMirrorOwnership,
  type HostMirrorResource
} from "./hostMirrorOwnership.js";
import type { StreamingCommandRunner } from "./types.js";
import { listWorkspaces, stopWorkspaceForHostShutdown } from "./workspaceLifecycle.js";

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
    const mirrorOwnership = await state.readHostMirrorOwnership();
    if (mirrorOwnership === undefined) throw new UserError("host mirror ownership state not found");
    const registryCache = await inspectHostMirrorContainer(runner, mirrorOwnership, "registry-cache");
    const aptCache = await inspectHostMirrorContainer(runner, mirrorOwnership, "apt-cache");
    const workspaces = await listWorkspaces(runner, options);
    const resumeWorkspaces = workspaces
      .filter((workspace) => workspace.phase === "ready")
      .map((workspace) => workspace.name);
    const shutdownWorkspaces = workspaces
      .filter((workspace) => workspace.phase === "ready" || workspace.phase === "discarding")
      .map((workspace) => workspace.name);
    const ciRunners = await state.listCiRunners();
    const restartCiRunners = ciRunners
      .filter((record) => record.executor.phase === "ready")
      .map((record) => ({ project: record.projectName, name: record.name }));
    const workspaceContainers = new Set((await state.listWorkspaces()).map((workspace) => workspace.containerName));
    const runnerContainers = new Set(ciRunners.map((ciRunner) => ciRunner.executor.kind === "sysbox"
      ? ciRunner.executor.containerName
      : ciRunner.executor.supervisorName));
    const ordinaryContainers = await listRunningManagedContainers(runner, "label=dim.resource=ci-ordinary-job");
    const ordinaryNames = new Set(ordinaryContainers);
    const resumeManagedContainers = (await listRunningManagedContainers(runner)).filter((name) =>
      name !== GITEA_CONTAINER
      && name !== REGISTRY_CACHE_CONTAINER
      && name !== APT_CACHE_CONTAINER
      && !workspaceContainers.has(name)
      && !runnerContainers.has(name)
      && !ordinaryNames.has(name));
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
    for (const workspace of shutdownWorkspaces) {
      await attempt(errors, `stop workspace '${workspace}'`, () => stopWorkspaceForHostShutdown(runner, options, workspace));
    }
    for (const container of ordinaryContainers) {
      await attempt(errors, `remove disposable CI container '${container}'`, () => removeOrdinaryPoolContainer(runner, container));
    }
    for (const container of resumeManagedContainers) {
      await attempt(errors, `stop managed container '${container}'`, () => stopManagedContainer(runner, container));
    }
    if (registryCache?.running) {
      await attempt(errors, "stop registry cache", () => stopContainerById(runner, REGISTRY_CACHE_CONTAINER, registryCache.id));
    }
    if (aptCache?.running) {
      await attempt(errors, "stop APT cache", () => stopContainerById(runner, APT_CACHE_CONTAINER, aptCache.id));
    }
    if (options.giteaConnection.kind === "managed") {
      await attempt(errors, "stop Gitea", async () => {
        const service = await state.readGiteaService();
        const container = await inspectGiteaContainer(runner, service);
        if (container === undefined || !container.running) return;
        const stopped = await runner.run("docker", ["stop", container.id]);
        if (stopped.exitCode !== 0) throw new UserError(`failed to stop '${GITEA_CONTAINER}': ${stopped.stderr.trim()}`);
      });
    }
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

type HostMirrorContainerResource = Extract<HostMirrorResource, "registry-cache" | "apt-cache">;

const HOST_MIRROR_CONTAINER_NAMES = {
  "registry-cache": REGISTRY_CACHE_CONTAINER,
  "apt-cache": APT_CACHE_CONTAINER
} as const satisfies Readonly<Record<HostMirrorContainerResource, string>>;

async function inspectHostMirrorContainer(
  runner: StreamingCommandRunner,
  ownership: HostMirrorOwnership,
  resource: HostMirrorContainerResource
): Promise<{ readonly id: string; readonly running: boolean } | undefined> {
  const name = HOST_MIRROR_CONTAINER_NAMES[resource];
  const inspect = await runner.run("docker", [
    "container", "inspect", name, "--format", "{{.Id}}|{{index .Config.Labels \"dim.managed\"}}|{{index .Config.Labels \"dim.owner\"}}|{{index .Config.Labels \"dim.service-id\"}}|{{index .Config.Labels \"dim.resource\"}}|{{index .Config.Labels \"dim.resource-id\"}}|{{.State.Running}}"
  ]);
  if (inspect.exitCode !== 0) {
    if (/no such (?:container|object)/i.test(inspect.stderr)) return undefined;
    throw new UserError(`cannot inspect '${name}': ${inspect.stderr.trim()}`);
  }
  const [containerId, managed, owner, serviceId, actualResource, resourceId, running] = inspect.stdout.trim().split("|");
  if (!containerId || [managed, owner, serviceId, actualResource, resourceId].join("|") !== hostMirrorInspection(resource, ownership)) {
    throw new UserError(`Docker resource '${name}' conflicts with persisted host mirror ownership`);
  }
  return { id: containerId, running: running === "true" };
}

async function stopContainerById(
  runner: StreamingCommandRunner,
  name: string,
  containerId: string
): Promise<void> {
  const stopped = await runner.run("docker", ["stop", containerId]);
  if (stopped.exitCode !== 0) throw new UserError(`failed to stop '${name}': ${stopped.stderr.trim()}`);
}

async function stopManagedContainer(runner: StreamingCommandRunner, name: string): Promise<void> {
  const inspect = await runner.run("docker", [
    "container", "inspect", name, "--format", "{{.Id}}|{{index .Config.Labels \"dim.managed\"}}|{{index .Config.Labels \"dim.owner\"}}|{{index .Config.Labels \"dim.resource\"}}|{{index .Config.Labels \"dim.resource-id\"}}|{{.State.Running}}"
  ]);
  if (inspect.exitCode !== 0) {
    if (/no such (?:container|object)/i.test(inspect.stderr)) return;
    throw new UserError(`cannot inspect '${name}': ${inspect.stderr.trim()}`);
  }
  const [containerId, managed, owner, resource, resourceId, running] = inspect.stdout.trim().split("|");
  if (!containerId || managed !== "true" || owner !== "dim" || !resource || !resourceId) {
    throw new UserError(`Docker resource '${name}' is not managed by DIM`);
  }
  if (running !== "true") return;
  const stopped = await runner.run("docker", ["stop", containerId]);
  if (stopped.exitCode !== 0) throw new UserError(`failed to stop '${name}': ${stopped.stderr.trim()}`);
}

async function removeOrdinaryPoolContainer(runner: StreamingCommandRunner, name: string): Promise<void> {
  const inspect = await runner.run("docker", [
    "container", "inspect", name, "--format",
    "{{.Id}}|{{index .Config.Labels \"dim.managed\"}}|{{index .Config.Labels \"dim.owner\"}}|{{index .Config.Labels \"dim.host\"}}|{{index .Config.Labels \"dim.capacity\"}}|{{index .Config.Labels \"dim.claim\"}}|{{index .Config.Labels \"dim.project-id\"}}|{{index .Config.Labels \"dim.resource\"}}"
  ]);
  if (inspect.exitCode !== 0) {
    if (/no such (?:container|object)/i.test(inspect.stderr)) return;
    throw new UserError(`cannot inspect '${name}': ${inspect.stderr.trim()}`);
  }
  const [containerId, managed, owner, host, capacity, claim, projectId, resource] = inspect.stdout.trim().split("|");
  const ownershipValues = [host, capacity, claim, projectId];
  if (!containerId || managed !== "true" || owner !== "dim" || resource !== "ci-ordinary-job"
    || ownershipValues.some((value) => value === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))) {
    throw new UserError(`Docker resource '${name}' is not an owned ordinary CI container`);
  }
  const removed = await runner.run("docker", ["container", "rm", "--force", containerId]);
  if (removed.exitCode !== 0 && !/no such (?:container|object)/i.test(removed.stderr)) {
    throw new UserError(`failed to remove '${name}': ${removed.stderr.trim()}`);
  }
}

async function listRunningManagedContainers(runner: StreamingCommandRunner, resourceFilter?: string): Promise<string[]> {
  const listed = await runner.run("docker", [
    "container", "ls", "--filter", "label=dim.managed=true",
    ...(resourceFilter === undefined ? [] : ["--filter", resourceFilter]),
    "--format", "{{.Names}}"
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
