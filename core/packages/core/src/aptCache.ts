import { UserError } from "./errors.js";
import { requireHostMirrorProvider } from "./hostMirrorProvider.js";
import { LifecycleState } from "./lifecycleState.js";
import type { LifecycleOptions } from "./lifecycleTypes.js";
import { CONTROL_NETWORK } from "./registryCache.js";
import type { StreamingCommandRunner } from "./types.js";
import {
  createHostMirrorOwnership,
  hostMirrorInspection,
  hostMirrorLabels,
  type HostMirrorOwnership
} from "./hostMirrorOwnership.js";

export const APT_CACHE_CONTAINER = "dim-apt-cache";
export const APT_CACHE_VOLUME = "dim-apt-cache-data";
export const APT_CACHE_ENDPOINT = `${APT_CACHE_CONTAINER}:3142`;

export async function ensureAptCache(
  runner: StreamingCommandRunner,
  options: LifecycleOptions
): Promise<void> {
  const image = requireHostMirrorProvider(options.hostMirrorProvider).aptImage;
  const release = await new LifecycleState(options.stateRoot).acquireRegistryCacheLock();
  try {
    const state = new LifecycleState(options.stateRoot);
    const ownership = await ensureHostMirrorOwnership(state);
    const volume = await runner.run("docker", [
      "volume", "inspect", APT_CACHE_VOLUME, "--format", ownershipFormat(".Labels")
    ]);
    if (volume.exitCode === 0) {
      if (volume.stdout.trim() !== hostMirrorInspection("apt-cache-data", ownership)) {
        throw new UserError(`Docker resource '${APT_CACHE_VOLUME}' exists but is not managed by dim`);
      }
    } else if (isMissingVolume(volume.stderr)) {
      assertCommand(await runner.run("docker", [
        "volume", "create", ...hostMirrorLabels("apt-cache-data", ownership).flatMap((label) => ["--label", label]), APT_CACHE_VOLUME
      ]), "create APT cache volume");
    } else {
      throw new UserError(`failed to inspect Docker volume '${APT_CACHE_VOLUME}': ${volume.stderr.trim()}`);
    }

    const inspect = await runner.run("docker", [
      "container", "inspect", APT_CACHE_CONTAINER,
      "--format", `{{.Id}}|${ownershipFormat(".Config.Labels")}|{{.State.Running}}|{{.Config.Image}}|{{.HostConfig.NetworkMode}}|{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}}:{{.RW}}{{end}}|{{json .Config.Env}}|{{.HostConfig.RestartPolicy.Name}}|{{json (index .NetworkSettings.Networks "${CONTROL_NETWORK}").Aliases}}`
    ]);
    if (inspect.exitCode === 0) {
      const [containerId, managed, owner, serviceId, resource, resourceId, running, currentImage,
        networkMode, mount, environmentJson, restartPolicy, aliasesJson] = inspect.stdout.trim().split("|");
      if (!containerId || [managed, owner, serviceId, resource, resourceId].join("|") !== hostMirrorInspection("apt-cache", ownership)) {
        throw new UserError(`Docker resource '${APT_CACHE_CONTAINER}' exists but is not managed by dim`);
      }
      if (networkMode !== CONTROL_NETWORK
        || mount !== `volume:${APT_CACHE_VOLUME}:/var/cache/apt-cacher-ng:true`
        || restartPolicy !== "unless-stopped"
        || !stringArrayIncludes(aliasesJson, APT_CACHE_CONTAINER)
        || !stringArrayIncludes(environmentJson, "DIM_HOST_MIRROR_RESOURCE=apt-cache")) {
        throw new UserError(`Docker resource '${APT_CACHE_CONTAINER}' has unexpected runtime configuration`);
      }
      if (currentImage !== image) {
        assertCommand(await runner.run("docker", ["container", "rm", "--force", containerId]), "replace APT cache");
        await startAptCache(runner, image, ownership);
      } else if (running !== "true") {
        assertCommand(await runner.run("docker", ["start", containerId]), "start APT cache");
      }
      return;
    }
    if (!isMissingContainer(inspect.stderr)) {
      throw new UserError(`failed to inspect Docker container '${APT_CACHE_CONTAINER}': ${inspect.stderr.trim()}`);
    }
    await startAptCache(runner, image, ownership);
  } finally {
    await release();
  }
}

export function aptCacheContainerArgs(image: string, ownership: HostMirrorOwnership): string[] {
  return [
    "run", "--detach",
    "--name", APT_CACHE_CONTAINER,
    "--restart", "unless-stopped",
    "--network", CONTROL_NETWORK,
    "--network-alias", APT_CACHE_CONTAINER,
    "--mount", `type=volume,source=${APT_CACHE_VOLUME},target=/var/cache/apt-cacher-ng`,
    ...hostMirrorLabels("apt-cache", ownership).flatMap((label) => ["--label", label]),
    "--env", "DIM_HOST_MIRROR_RESOURCE=apt-cache",
    image
  ];
}

async function startAptCache(runner: StreamingCommandRunner, image: string, ownership: HostMirrorOwnership): Promise<void> {
  assertCommand(await runner.run("docker", aptCacheContainerArgs(image, ownership)), "start APT cache");
}

async function ensureHostMirrorOwnership(state: LifecycleState): Promise<HostMirrorOwnership> {
  const existing = await state.readHostMirrorOwnership();
  if (existing !== undefined) return existing;
  const created = createHostMirrorOwnership();
  await state.writeHostMirrorOwnership(created);
  return created;
}

function isMissingVolume(stderr: string): boolean {
  return stderr.trim().toLowerCase()
    === `Error response from daemon: get ${APT_CACHE_VOLUME}: no such volume`.toLowerCase();
}

function isMissingContainer(stderr: string): boolean {
  return stderr.trim().toLowerCase()
    === `Error response from daemon: No such container: ${APT_CACHE_CONTAINER}`.toLowerCase();
}

function assertCommand(result: { readonly exitCode: number; readonly stderr: string }, action: string): void {
  if (result.exitCode !== 0) throw new UserError(`failed to ${action}: ${result.stderr.trim()}`);
}

function ownershipFormat(labels: ".Labels" | ".Config.Labels"): string {
  return `{{index ${labels} \"dim.managed\"}}|{{index ${labels} \"dim.owner\"}}|{{index ${labels} \"dim.service-id\"}}|{{index ${labels} \"dim.resource\"}}|{{index ${labels} \"dim.resource-id\"}}`;
}

function stringArrayIncludes(value: string | undefined, expected: string): boolean {
  if (value === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.includes(expected);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}
