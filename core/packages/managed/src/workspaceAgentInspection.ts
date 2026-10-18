import { UserError } from "@slop-lab/dim-core";
import { isAbsolute } from "node:path";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import {
  workspaceAgentContainerLabels,
  workspaceAgentIdentity
} from "./workspaceAgentRuntime.js";

const format = "{{.Id}}|{{.State.Running}}|{{.Image}}|{{.HostConfig.Runtime}}|{{.HostConfig.Privileged}}|{{json .Config.Labels}}|{{json .Mounts}}";

export type InspectedWorkspaceAgent = {
  readonly id: string;
  readonly image: string;
  readonly running: boolean;
};

export async function inspectWorkspaceAgentContainer(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<InspectedWorkspaceAgent | undefined> {
  const identity = workspaceAgentIdentity(record);
  const result = await runner.run("docker", ["container", "inspect", identity.containerName, "--format", format]);
  if (result.exitCode !== 0) {
    if (missing(result.stderr, identity.containerName)) return undefined;
    throw new UserError(`failed to inspect recommended workspace agent: ${result.stderr.trim()}`);
  }
  const fields = result.stdout.trim().split("|");
  const [id, running, image, runtime, privileged, rawLabels, rawMounts] = fields;
  if (fields.length !== 7 || id === undefined || !/^[0-9a-f]{64}$/.test(id)
    || image === undefined || !/^sha256:[0-9a-f]{64}$/.test(image) || (running !== "true" && running !== "false")
    || runtime !== "sysbox-runc" || privileged !== "false") conflict(identity.containerName);
  assertLabels(identity.containerName, rawLabels, workspaceAgentContainerLabels(record));
  assertMounts(identity.containerName, rawMounts, identity);
  return { id, image, running: running === "true" };
}

function assertLabels(name: string, raw: string | undefined, expected: readonly string[]): void {
  const labels = parseObject(raw, name);
  if (expected.some((label) => Reflect.get(labels, label.slice(0, label.indexOf("=")))
    !== label.slice(label.indexOf("=") + 1))) conflict(name);
}

function assertMounts(
  name: string,
  raw: string | undefined,
  identity: ReturnType<typeof workspaceAgentIdentity>
): void {
  let value: unknown;
  try { value = JSON.parse(raw ?? ""); } catch { conflict(name); }
  if (!Array.isArray(value) || value.length !== 3) conflict(name);
  const expected = new Map<string, string>([
    ["/home/dim", identity.homeVolumeName],
    ["/workspace", identity.checkoutVolumeName],
    ["/var/lib/docker", identity.dockerVolumeName]
  ]);
  for (const mount of value) {
    const parsed = parseObject(mount, name);
    if (parsed.Type !== "volume" || parsed.RW !== true || typeof parsed.Destination !== "string"
      || typeof parsed.Name !== "string" || parsed.Name !== expected.get(parsed.Destination)
      || typeof parsed.Source !== "string" || !isAbsolute(parsed.Source)) conflict(name);
    expected.delete(parsed.Destination);
  }
  if (expected.size !== 0) conflict(name);
}

function parseObject(value: unknown, name: string): Readonly<Record<string, unknown>> {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { conflict(name); }
  }
  if (!isRecord(parsed)) conflict(name);
  return parsed;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missing(stderr: string, name: string): boolean {
  const diagnostic = stderr.trim().toLowerCase();
  return diagnostic.includes(`no such container: ${name}`) || diagnostic.includes(`${name} not found`);
}

function conflict(name: string): never {
  throw new UserError(`Docker container '${name}' conflicts with DIM ownership`);
}
