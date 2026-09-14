import { UserError } from "./errors.js";
import { LifecycleState } from "./lifecycleState.js";
import type { StreamingCommandRunner } from "./types.js";

export const CONTROL_NETWORK = "dim-control";
export const REGISTRY_CACHE_CONTAINER = "dim-registry-cache";
export const REGISTRY_CACHE_VOLUME = "dim-registry-cache-data";
export const REGISTRY_CACHE_IMAGE = "registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33";
export const REGISTRY_CACHE_ENDPOINT = `${REGISTRY_CACHE_CONTAINER}:5000`;
export const DOCKER_HUB_DIRECT_HOSTNAMES = ["registry-1.docker.io", "auth.docker.io"] as const;

type DockerResourceType = "network" | "volume" | "container";

type ManagedResourcePlan = {
  readonly type: "network" | "volume";
  readonly name: string;
  readonly inspectArgs: string[];
  readonly createArgs: string[];
};

const missingResourceDiagnostic = {
  network: (name: string) => `Error response from daemon: network ${name} not found`,
  volume: (name: string) => `Error response from daemon: get ${name}: no such volume`,
  container: (name: string) => `Error response from daemon: No such container: ${name}`
} as const satisfies Record<DockerResourceType, (name: string) => string>;

export async function ensureRegistryCache(
  runner: StreamingCommandRunner,
  stateRoot: string
): Promise<void> {
  const release = await new LifecycleState(stateRoot).acquireRegistryCacheLock();
  try {
    await ensureManagedResource(runner, {
      type: "network",
      name: CONTROL_NETWORK,
      inspectArgs: ["network", "inspect", CONTROL_NETWORK, "--format", "{{index .Labels \"dim.managed\"}}"],
      createArgs: ["network", "create", "--label", "dim.managed=true", "--label", "dim.resource=network", CONTROL_NETWORK]
    });
    await ensureManagedResource(runner, {
      type: "volume",
      name: REGISTRY_CACHE_VOLUME,
      inspectArgs: ["volume", "inspect", REGISTRY_CACHE_VOLUME, "--format", "{{index .Labels \"dim.managed\"}}"],
      createArgs: ["volume", "create", "--label", "dim.managed=true", "--label", "dim.resource=registry-cache-data", REGISTRY_CACHE_VOLUME]
    });

    const inspect = await runner.run("docker", [
      "container", "inspect", REGISTRY_CACHE_CONTAINER,
      "--format", "{{index .Config.Labels \"dim.managed\"}}|{{.State.Running}}|{{.Config.Image}}"
    ]);
    if (inspect.exitCode === 0) {
      const [managed, running, image] = inspect.stdout.trim().split("|");
      if (managed !== "true") throw new UserError(`Docker resource '${REGISTRY_CACHE_CONTAINER}' exists but is not managed by dim`);
      if (image !== REGISTRY_CACHE_IMAGE) {
        assertCommand(await runner.run("docker", ["container", "rm", "--force", REGISTRY_CACHE_CONTAINER]), "replace registry cache");
        await startRegistryCache(runner);
      } else if (running !== "true") {
        assertCommand(await runner.run("docker", ["start", REGISTRY_CACHE_CONTAINER]), "start registry cache");
      }
      return;
    }
    if (!isMissingDockerResource("container", REGISTRY_CACHE_CONTAINER, inspect.stderr)) {
      throw new UserError(`failed to inspect Docker container '${REGISTRY_CACHE_CONTAINER}': ${inspect.stderr.trim()}`);
    }
    await startRegistryCache(runner);
  } finally {
    await release();
  }
}

export async function configureSysboxRegistryMirror(
  runner: StreamingCommandRunner,
  volumeName: string
): Promise<void> {
  assertCommand(await runner.run("docker", sysboxRegistryConfigArgs(volumeName)), "configure CI runner registry mirror");
}

export function sysboxRegistryConfigArgs(volumeName: string): string[] {
  const config = Buffer.from(`${JSON.stringify({
    "registry-mirrors": [`http://${REGISTRY_CACHE_ENDPOINT}`],
    "insecure-registries": [REGISTRY_CACHE_ENDPOINT]
  }, null, 2)}\n`).toString("base64");
  return [
    "run", "--rm",
    "--mount", `type=volume,source=${volumeName},target=/data`,
    "--env", `DIM_REGISTRY_DAEMON_CONFIG=${config}`,
    "--entrypoint", "sh",
    REGISTRY_CACHE_IMAGE,
    "-c", "printf %s \"$DIM_REGISTRY_DAEMON_CONFIG\" | base64 -d > /data/docker-daemon.json && chmod 0444 /data/docker-daemon.json"
  ];
}

async function startRegistryCache(runner: StreamingCommandRunner): Promise<void> {
  assertCommand(await runner.run("docker", registryCacheContainerArgs()), "start registry cache");
}

export function registryCacheContainerArgs(): string[] {
  return [
    "run", "--detach",
    "--name", REGISTRY_CACHE_CONTAINER,
    "--restart", "unless-stopped",
    "--network", CONTROL_NETWORK,
    "--network-alias", REGISTRY_CACHE_CONTAINER,
    "--mount", `type=volume,source=${REGISTRY_CACHE_VOLUME},target=/var/lib/registry`,
    "--label", "dim.managed=true",
    "--label", "dim.resource=registry-cache",
    "--env", "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io",
    "--env", "REGISTRY_PROXY_TTL=168h",
    "--env", "REGISTRY_STORAGE_DELETE_ENABLED=true",
    "--env", "REGISTRY_LOG_LEVEL=info",
    "--env", "OTEL_TRACES_EXPORTER=none",
    REGISTRY_CACHE_IMAGE
  ];
}

async function ensureManagedResource(
  runner: StreamingCommandRunner,
  plan: ManagedResourcePlan
): Promise<void> {
  const inspected = await runner.run("docker", plan.inspectArgs);
  if (inspected.exitCode === 0) {
    if (inspected.stdout.trim() !== "true") throw new UserError(`Docker resource '${plan.name}' exists but is not managed by dim`);
    return;
  }
  if (!isMissingDockerResource(plan.type, plan.name, inspected.stderr)) {
    throw new UserError(`failed to inspect Docker ${plan.type} '${plan.name}': ${inspected.stderr.trim()}`);
  }
  assertCommand(await runner.run("docker", plan.createArgs), `create Docker ${plan.type}`);
}

function isMissingDockerResource(type: DockerResourceType, name: string, stderr: string): boolean {
  return stderr.trim().toLowerCase() === missingResourceDiagnostic[type](name).toLowerCase();
}

function assertCommand(result: { exitCode: number; stderr: string }, action: string): void {
  if (result.exitCode !== 0) throw new UserError(`failed to ${action}: ${result.stderr.trim()}`);
}
