import { UserError } from "@slop-lab/dim-core";
import { requireHostMirrorProvider } from "./hostMirrorProvider.js";
import { MirrorState as LifecycleState } from "./cacheState.js";
import type { MirrorOptions as LifecycleOptions } from "./cacheState.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import {
  createHostMirrorOwnership,
  hostMirrorInspection,
  hostMirrorLabels,
  type HostMirrorOwnership
} from "./hostMirrorOwnership.js";

export const CONTROL_NETWORK = "dim-control";
export const REGISTRY_CACHE_CONTAINER = "dim-registry-cache";
export const REGISTRY_CACHE_VOLUME = "dim-registry-cache-data";
export const REGISTRY_CACHE_ENDPOINT = `${REGISTRY_CACHE_CONTAINER}:5000`;
export const DOCKER_HUB_DIRECT_HOSTNAMES = ["registry-1.docker.io", "auth.docker.io"] as const;

type DockerResourceType = "network" | "volume" | "container";

type ManagedResourcePlan = {
  readonly type: "network" | "volume";
  readonly name: string;
  readonly inspectArgs: string[];
  readonly createArgs: string[];
  readonly expectedInspection?: string;
  readonly createMissing?: boolean;
};

const missingResourceDiagnostic = {
  network: (name: string) => `Error response from daemon: network ${name} not found`,
  volume: (name: string) => `Error response from daemon: get ${name}: no such volume`,
  container: (name: string) => `Error response from daemon: No such container: ${name}`
} as const satisfies Record<DockerResourceType, (name: string) => string>;

export function ensureRegistryCache(
  runner: StreamingCommandRunner,
  stateRoot: string,
  testImage: string
): Promise<void>;
export function ensureRegistryCache(
  runner: StreamingCommandRunner,
  options: LifecycleOptions
): Promise<void>;
export async function ensureRegistryCache(
  runner: StreamingCommandRunner,
  input: string | LifecycleOptions,
  testImage?: string
): Promise<void> {
  const stateRoot = typeof input === "string" ? input : input.stateRoot;
  let image: string;
  if (typeof input === "string") {
    if (testImage === undefined) throw new UserError("registry cache tests require an explicit image");
    image = testImage;
  } else {
    image = requireHostMirrorProvider(input.hostMirrorProvider).dockerImage;
  }
  const state = new LifecycleState(stateRoot);
  const release = await state.acquireRegistryCacheLock();
    try {
      const ownership = await ensureHostMirrorOwnership(state);
      await ensureManagedResource(runner, {
        type: "network",
        name: CONTROL_NETWORK,
        inspectArgs: ["network", "inspect", CONTROL_NETWORK, "--format", ownershipFormat(".Labels")],
        createArgs: ["network", "create", ...hostMirrorLabels("control-network", ownership).flatMap((label) => ["--label", label]), CONTROL_NETWORK],
        expectedInspection: hostMirrorInspection("control-network", ownership)
      });
      await ensureManagedResource(runner, {
        type: "volume",
        name: REGISTRY_CACHE_VOLUME,
        inspectArgs: ["volume", "inspect", REGISTRY_CACHE_VOLUME, "--format", ownershipFormat(".Labels")],
        createArgs: ["volume", "create", ...hostMirrorLabels("registry-cache-data", ownership).flatMap((label) => ["--label", label]), REGISTRY_CACHE_VOLUME],
        expectedInspection: hostMirrorInspection("registry-cache-data", ownership)
      });

      const inspect = await runner.run("docker", [
        "container", "inspect", REGISTRY_CACHE_CONTAINER,
        "--format", `{{.Id}}|${ownershipFormat(".Config.Labels")}|{{.State.Running}}|{{.Config.Image}}|{{.HostConfig.NetworkMode}}|{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}}:{{.RW}}{{end}}|{{json .Config.Env}}|{{.HostConfig.RestartPolicy.Name}}|{{json (index .NetworkSettings.Networks "${CONTROL_NETWORK}").Aliases}}`
      ]);
      if (inspect.exitCode === 0) {
        const [containerId, managed, owner, serviceId, resource, resourceId, running, currentImage,
          networkMode, mount, environmentJson, restartPolicy, aliasesJson] = inspect.stdout.trim().split("|");
        if (!containerId || [managed, owner, serviceId, resource, resourceId].join("|") !== hostMirrorInspection("registry-cache", ownership)) {
          throw new UserError(`Docker resource '${REGISTRY_CACHE_CONTAINER}' exists but is not managed by dim`);
        }
        if (networkMode !== CONTROL_NETWORK
          || mount !== `volume:${REGISTRY_CACHE_VOLUME}:/var/lib/registry:true`
          || restartPolicy !== "unless-stopped"
          || !stringArrayIncludes(aliasesJson, REGISTRY_CACHE_CONTAINER)
          || !stringArrayContainsAll(environmentJson, [
            "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io",
            "REGISTRY_PROXY_TTL=168h",
            "REGISTRY_STORAGE_DELETE_ENABLED=true",
            "REGISTRY_LOG_LEVEL=info",
            "OTEL_TRACES_EXPORTER=none"
          ])) {
          throw new UserError(`Docker resource '${REGISTRY_CACHE_CONTAINER}' has unexpected runtime configuration`);
        }
        if (currentImage !== image) {
          assertCommand(await runner.run("docker", ["container", "rm", "--force", containerId]), "replace registry cache");
          await startRegistryCache(runner, image, ownership);
        } else if (running !== "true") {
          assertCommand(await runner.run("docker", ["start", containerId]), "start registry cache");
        }
        return;
      }
      if (!isMissingDockerResource("container", REGISTRY_CACHE_CONTAINER, inspect.stderr)) {
        throw new UserError(`failed to inspect Docker container '${REGISTRY_CACHE_CONTAINER}': ${inspect.stderr.trim()}`);
      }
      await startRegistryCache(runner, image, ownership);
  } finally {
    await release();
  }
}

export function sysboxRegistryDaemonConfig(): string {
  return `${JSON.stringify({
    "registry-mirrors": [`http://${REGISTRY_CACHE_ENDPOINT}`],
    "insecure-registries": [REGISTRY_CACHE_ENDPOINT]
  }, null, 2)}\n`;
}

async function startRegistryCache(runner: StreamingCommandRunner, image: string, ownership: HostMirrorOwnership): Promise<void> {
  assertCommand(await runner.run("docker", registryCacheContainerArgs(image, ownership)), "start registry cache");
}

export function registryCacheContainerArgs(image: string, ownership: HostMirrorOwnership): string[] {
  return [
    "run", "--detach",
    "--name", REGISTRY_CACHE_CONTAINER,
    "--restart", "unless-stopped",
    "--network", CONTROL_NETWORK,
    "--network-alias", REGISTRY_CACHE_CONTAINER,
    "--mount", `type=volume,source=${REGISTRY_CACHE_VOLUME},target=/var/lib/registry`,
    ...hostMirrorLabels("registry-cache", ownership).flatMap((label) => ["--label", label]),
    "--env", "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io",
    "--env", "REGISTRY_PROXY_TTL=168h",
    "--env", "REGISTRY_STORAGE_DELETE_ENABLED=true",
    "--env", "REGISTRY_LOG_LEVEL=info",
    "--env", "OTEL_TRACES_EXPORTER=none",
    image
  ];
}

async function ensureHostMirrorOwnership(state: LifecycleState): Promise<HostMirrorOwnership> {
  const existing = await state.readHostMirrorOwnership();
  if (existing !== undefined) return existing;
  const created = createHostMirrorOwnership();
  await state.writeHostMirrorOwnership(created);
  return created;
}


async function ensureManagedResource(
  runner: StreamingCommandRunner,
  plan: ManagedResourcePlan
): Promise<void> {
  const inspected = await runner.run("docker", plan.inspectArgs);
  if (inspected.exitCode === 0) {
    if (inspected.stdout.trim() !== (plan.expectedInspection ?? "true")) {
      throw new UserError(`Docker resource '${plan.name}' exists but is not managed by dim`);
    }
    return;
  }
  if (!isMissingDockerResource(plan.type, plan.name, inspected.stderr)) {
    throw new UserError(`failed to inspect Docker ${plan.type} '${plan.name}': ${inspected.stderr.trim()}`);
  }
  if (plan.createMissing === false) throw new UserError(`Established Docker ${plan.type} '${plan.name}' is missing`);
  assertCommand(await runner.run("docker", plan.createArgs), `create Docker ${plan.type}`);
}

function isMissingDockerResource(type: DockerResourceType, name: string, stderr: string): boolean {
  return stderr.trim().toLowerCase() === missingResourceDiagnostic[type](name).toLowerCase();
}

function assertCommand(result: { exitCode: number; stderr: string }, action: string): void {
  if (result.exitCode !== 0) throw new UserError(`failed to ${action}: ${result.stderr.trim()}`);
}

function ownershipFormat(labels: ".Labels" | ".Config.Labels"): string {
  return `{{index ${labels} \"dim.managed\"}}|{{index ${labels} \"dim.owner\"}}|{{index ${labels} \"dim.service-id\"}}|{{index ${labels} \"dim.resource\"}}|{{index ${labels} \"dim.resource-id\"}}`;
}

function stringArrayIncludes(value: string | undefined, expected: string): boolean {
  return parseStringArray(value).includes(expected);
}

function stringArrayContainsAll(value: string | undefined, expected: readonly string[]): boolean {
  const values = new Set(parseStringArray(value));
  return expected.every((entry) => values.has(entry));
}

function parseStringArray(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}
