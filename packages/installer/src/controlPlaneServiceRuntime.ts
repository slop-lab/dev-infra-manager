import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectControlPlaneDocker } from "./controlPlaneDockerInspect.js";
import {
  type ControlPlaneDockerCommandResult,
  type ControlPlaneDockerRunner
} from "./controlPlaneDockerTypes.js";

const project = "dim-control-plane";
const outputLimit = 64 * 1024;
const commandTimeout = 60_000;
const formatNetwork = "{{.Id}}\n{{.Driver}}\n{{json .Labels}}";
const formatVolume = "{{.Name}}\n{{.Driver}}\n{{json .Labels}}";
const formatContainer = "{{.Id}}\n{{.Name}}\n{{json .Config.Labels}}";

export type ControlPlaneComposeFile = {
  readonly path: string;
  close(): Promise<void>;
};

export async function createControlPlaneComposeFile(bytes: Buffer): Promise<ControlPlaneComposeFile> {
  const directory = await mkdtemp(join(tmpdir(), "dim-control-plane-compose-"));
  await chmod(directory, 0o700);
  const path = join(directory, "compose.yml");
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
  return { path, async close() { await rm(directory, { recursive: true, force: true }); } };
}

export async function validateControlPlaneCompose(runner: ControlPlaneDockerRunner, composePath: string): Promise<void> {
  await quiet(runner, composeArgs(composePath, ["config", "--quiet"]), "Compose candidate validation failed");
}

export async function establishFirstControlPlaneResources(
  runner: ControlPlaneDockerRunner,
  deploymentId: string
): Promise<void> {
  await created(runner, [
    "network", "create", "--driver", "bridge",
    ...labelArgs(labels("network", deploymentId)), project
  ], /^[0-9a-f]{64}\n$/, "control-plane network creation failed");
  await assertUnusedOwned({ runner, kind: "network", name: project, deploymentId });
  for (const service of ["native-git", "ordinary-ci"] as const) {
    const name = volumeName(service);
    await created(runner, [
      "volume", "create", "--driver", "local",
      ...labelArgs({
        ...labels("volume", deploymentId, service),
        "com.docker.compose.volume": name
      }), name
    ], new RegExp(`^${name}\\n$`), "control-plane data volume creation failed");
    await assertUnusedOwned({ runner, kind: "volume", name, deploymentId, service });
  }
}

export async function startFirstControlPlaneService(input: {
  readonly runner: ControlPlaneDockerRunner;
  readonly composePath: string;
  readonly deploymentId: string;
  readonly service: "native-git" | "ordinary-ci";
}): Promise<void> {
  await completed(input.runner, composeArgs(input.composePath, [
    "up", "--detach", "--no-deps", "--no-build", "--pull", "never", input.service
  ]), `control-plane ${input.service} start failed`);
  const owned = await inspectOwned(input.runner, "container", containerName(input.service), input.deploymentId, input.service);
  if (owned === undefined) throw new ControlPlaneRuntimeError(`control-plane ${input.service} container is missing after start`);
}

export async function assertFirstControlPlaneResources(
  runner: ControlPlaneDockerRunner,
  deploymentId: string
): Promise<void> {
  const state = await inspectControlPlaneDocker(runner, deploymentId);
  if (state.kind !== "owned") throw new ControlPlaneRuntimeError("control-plane resources are not complete after service start");
}

export async function cleanupFailedFirstControlPlane(input: {
  readonly runner: ControlPlaneDockerRunner;
  readonly deploymentId: string;
}): Promise<void> {
  for (const service of ["native-git", "ordinary-ci"] as const) {
    const owned = await inspectOwned(input.runner, "container", containerName(service), input.deploymentId, service);
    if (owned !== undefined) await removed(input.runner, ["container", "rm", "--force", owned], owned,
      "owned replacement container cleanup failed");
  }
  const network = await inspectOwned(input.runner, "network", project, input.deploymentId);
  if (network !== undefined) await removed(input.runner, ["network", "rm", network], network,
    "owned control-plane network cleanup failed");
}

async function inspectOwned(
  runner: ControlPlaneDockerRunner,
  kind: "container" | "network" | "volume",
  name: string,
  deploymentId: string,
  service?: "native-git" | "ordinary-ci"
): Promise<string | undefined> {
  const format = kind === "container" ? formatContainer : kind === "network" ? formatNetwork : formatVolume;
  const result = await run(runner, [kind, "inspect", name, "--format", format]);
  if (result.exitCode !== 0) {
    if (missing(kind, name, result)) return undefined;
    throw new ControlPlaneRuntimeError(`cannot verify ${kind} ownership before cleanup`);
  }
  if (result.stderr !== "") throw new ControlPlaneRuntimeError(`cannot verify ${kind} ownership before cleanup`);
  const lines = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1).split("\n") : result.stdout.split("\n");
  if (lines.length !== 3) throw new ControlPlaneRuntimeError(`cannot verify ${kind} ownership before cleanup`);
  const id = lines[0];
  const detail = lines[1];
  const actual = parseLabels(lines[2]);
  const resource = kind === "container" ? "service" : kind;
  const expected = labels(resource, deploymentId, service);
  const validIdentity = kind === "volume" ? id === name && detail === "local"
    : id !== undefined && /^[0-9a-f]{64}$/.test(id) && detail === (kind === "container" ? `/${name}` : "bridge");
  if (!validIdentity || actual === undefined
    || !exactDimLabels(actual, expected)
    || actual["com.docker.compose.project"] !== project
    || (kind === "network" && actual["com.docker.compose.network"] !== project)
    || (kind === "volume" && actual["com.docker.compose.volume"] !== name)
    || (kind === "container" && (actual["com.docker.compose.service"] !== service
      || actual["com.docker.compose.container-number"] !== "1" || actual["com.docker.compose.oneoff"] !== "False"))) {
    throw new ControlPlaneRuntimeError(`refusing to remove foreign ${kind} resource`);
  }
  return id;
}

async function assertUnusedOwned(input: {
  readonly runner: ControlPlaneDockerRunner;
  readonly kind: "network" | "volume";
  readonly name: string;
  readonly deploymentId: string;
  readonly service?: "native-git" | "ordinary-ci";
}): Promise<void> {
  const identity = await inspectOwned(input.runner, input.kind, input.name, input.deploymentId, input.service);
  if (identity === undefined) throw new ControlPlaneRuntimeError(`created control-plane ${input.kind} is missing`);
  const result = await run(input.runner, [
    "container", "ls", "--all", "--no-trunc", "--filter", `${input.kind}=${input.name}`, "--format", "{{.ID}}"
  ]);
  if (result.exitCode !== 0 || result.stdout !== "" || result.stderr !== "") {
    throw new ControlPlaneRuntimeError(`created control-plane ${input.kind} has foreign users`);
  }
}

function labels(
  resource: "network" | "volume" | "service",
  deploymentId: string,
  service?: "native-git" | "ordinary-ci"
): Readonly<Record<string, string>> {
  return {
    "com.docker.compose.project": project,
    ...(resource === "network" ? { "com.docker.compose.network": project } : {}),
    "org.dim.managed": "true",
    "org.dim.bundle": "control-plane",
    "org.dim.deployment": deploymentId,
    "org.dim.resource": resource,
    ...(service === undefined ? {} : { "org.dim.service": service })
  };
}

function exactDimLabels(actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): boolean {
  const actualKeys = Object.keys(actual).filter((key) => key.startsWith("org.dim.")).sort();
  const expectedKeys = Object.keys(expected).filter((key) => key.startsWith("org.dim.")).sort();
  return actualKeys.join("\0") === expectedKeys.join("\0")
    && expectedKeys.every((key) => actual[key] === expected[key]);
}

function labelArgs(values: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(values).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

function composeArgs(path: string, action: readonly string[]): readonly string[] {
  return ["compose", "--project-name", project, "--file", path, ...action];
}

function containerName(service: "native-git" | "ordinary-ci"): string {
  return `${project}-${service}-1`;
}

function volumeName(service: "native-git" | "ordinary-ci"): string {
  return `${project}-${service}-data`;
}

async function quiet(runner: ControlPlaneDockerRunner, args: readonly string[], message: string): Promise<void> {
  const result = await run(runner, args);
  if (result.exitCode !== 0 || result.stdout !== "" || result.stderr !== "") throw new ControlPlaneRuntimeError(message);
}

async function completed(runner: ControlPlaneDockerRunner, args: readonly string[], message: string): Promise<void> {
  const result = await run(runner, args);
  if (result.exitCode !== 0) throw new ControlPlaneRuntimeError(message);
}

async function removed(
  runner: ControlPlaneDockerRunner,
  args: readonly string[],
  identity: string,
  message: string
): Promise<void> {
  const result = await run(runner, args);
  if (result.exitCode !== 0 || result.stderr !== "" || result.stdout !== `${identity}\n`) {
    throw new ControlPlaneRuntimeError(message);
  }
}

async function created(
  runner: ControlPlaneDockerRunner,
  args: readonly string[],
  output: RegExp,
  message: string
): Promise<void> {
  const result = await run(runner, args);
  if (result.exitCode !== 0 || result.stderr !== "" || !output.test(result.stdout)) throw new ControlPlaneRuntimeError(message);
}

async function run(runner: ControlPlaneDockerRunner, args: readonly string[]): Promise<ControlPlaneDockerCommandResult> {
  return await runner.run({ args, timeoutMilliseconds: commandTimeout, maximumOutputBytes: outputLimit });
}

function missing(kind: "container" | "network" | "volume", name: string, result: ControlPlaneDockerCommandResult): boolean {
  const diagnostic = result.stderr.trim().toLowerCase();
  if (result.stdout !== "" && result.stdout !== "\n") return false;
  if (kind === "network") return diagnostic === `error response from daemon: network ${name} not found`;
  if (kind === "volume") return diagnostic === `error response from daemon: get ${name}: no such volume`;
  return [
      `error response from daemon: no such container: ${name}`,
      `error response from daemon: no such object: ${name}`
    ].includes(diagnostic);
}

function parseLabels(value: string | undefined): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return undefined;
    const labels: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (typeof entry !== "string") return undefined;
      labels[key] = entry;
    }
    return labels;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ControlPlaneRuntimeError extends Error {
  readonly name = "ControlPlaneRuntimeError";
}
