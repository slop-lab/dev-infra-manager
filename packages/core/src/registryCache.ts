import { isIP } from "node:net";
import { UserError } from "./errors.js";
import type { StreamingCommandRunner } from "./types.js";

export const CONTROL_NETWORK = "dim-control";
export const REGISTRY_CACHE_CONTAINER = "dim-registry-cache";
export const REGISTRY_CACHE_VOLUME = "dim-registry-cache-data";
export const REGISTRY_CACHE_IMAGE = "registry@sha256:1be55279f18a2fe1a74edf2664cac61c1bea305b7b4642dab412e7affdcb3e33";
export const REGISTRY_CACHE_ENDPOINT = `${REGISTRY_CACHE_CONTAINER}:5000`;

export interface RegistryCacheConnection {
  endpoint: string;
  address: string;
}

export async function ensureRegistryCache(
  runner: StreamingCommandRunner
): Promise<RegistryCacheConnection> {
  await ensureManagedResource(runner, [
    "network", "inspect", CONTROL_NETWORK, "--format", "{{index .Labels \"dim.managed\"}}"
  ], [
    "network", "create", "--label", "dim.managed=true", "--label", "dim.resource=network", CONTROL_NETWORK
  ], CONTROL_NETWORK);
  await ensureManagedResource(runner, [
    "volume", "inspect", REGISTRY_CACHE_VOLUME, "--format", "{{index .Labels \"dim.managed\"}}"
  ], [
    "volume", "create", "--label", "dim.managed=true", "--label", "dim.resource=registry-cache-data", REGISTRY_CACHE_VOLUME
  ], REGISTRY_CACHE_VOLUME);

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
  } else {
    await startRegistryCache(runner);
  }

  const address = await runner.run("docker", [
    "container", "inspect", REGISTRY_CACHE_CONTAINER,
    "--format", `{{with index .NetworkSettings.Networks "${CONTROL_NETWORK}"}}{{.IPAddress}}{{end}}`
  ]);
  assertCommand(address, "resolve registry cache control-network address");
  if (isIP(address.stdout.trim()) !== 4) {
    throw new UserError("registry cache has no valid control-network address");
  }
  return { endpoint: REGISTRY_CACHE_ENDPOINT, address: address.stdout.trim() };
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
  inspectArgs: string[],
  createArgs: string[],
  name: string
): Promise<void> {
  const inspected = await runner.run("docker", inspectArgs);
  if (inspected.exitCode === 0) {
    if (inspected.stdout.trim() !== "true") throw new UserError(`Docker resource '${name}' exists but is not managed by dim`);
    return;
  }
  assertCommand(await runner.run("docker", createArgs), `create Docker ${createArgs[0]}`);
}

function assertCommand(result: { exitCode: number; stderr: string }, action: string): void {
  if (result.exitCode !== 0) throw new UserError(`failed to ${action}: ${result.stderr.trim()}`);
}
