import { runCommand } from "./process.js";

export type WorkspaceView = {
  readonly id: string;
  readonly name: string;
  readonly phase: string;
  readonly resources: {
    readonly cpuCount: string;
    readonly memory: string;
    readonly pidsLimit: string;
  };
};

export type ContainerInspection = {
  readonly id: string;
  readonly running: boolean;
  readonly runtime: string;
  readonly nanoCpus: string;
  readonly memory: string;
  readonly memorySwap: string;
  readonly pidsLimit: string;
  readonly labels: readonly string[];
};

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function requiredObject(value: unknown, name: string): object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

export function parseWorkspaceList(stdout: string): readonly WorkspaceView[] {
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value)) throw new TypeError("workspace list must be an array");
  return value.map((entry, index) => {
    const workspace = requiredObject(entry, `workspace[${index}]`);
    const resources = requiredObject(field(workspace, "resources"), `workspace[${index}].resources`);
    return {
      id: requiredString(field(workspace, "id"), "workspace.id"),
      name: requiredString(field(workspace, "name"), "workspace.name"),
      phase: requiredString(field(workspace, "phase"), "workspace.phase"),
      resources: {
        cpuCount: requiredString(field(resources, "cpuCount"), "resources.cpuCount"),
        memory: requiredString(field(resources, "memory"), "resources.memory"),
        pidsLimit: requiredString(field(resources, "pidsLimit"), "resources.pidsLimit")
      }
    };
  });
}

export async function inspectContainer(name: string): Promise<ContainerInspection> {
  const format = [
    "{{.Id}}", "{{.State.Running}}", "{{.HostConfig.Runtime}}", "{{.HostConfig.NanoCpus}}",
    "{{.HostConfig.Memory}}", "{{.HostConfig.MemorySwap}}", "{{.HostConfig.PidsLimit}}",
    "{{index .Config.Labels \"dim.managed\"}}", "{{index .Config.Labels \"dim.workspace-id\"}}",
    "{{index .Config.Labels \"dim.resource\"}}", "{{index .Config.Labels \"dim.workspace-schema\"}}"
  ].join("|");
  const result = await runCommand("docker", ["container", "inspect", name, "--format", format]);
  const parts = result.stdout.trim().split("|");
  if (parts.length !== 11) throw new TypeError("Docker returned an invalid container inspection");
  const requiredPart = (index: number): string => {
    const value = parts[index];
    if (value === undefined) throw new TypeError("Docker inspection fields are missing");
    return value;
  };
  const id = requiredPart(0), running = requiredPart(1), runtime = requiredPart(2), nanoCpus = requiredPart(3);
  const memory = requiredPart(4), memorySwap = requiredPart(5), pidsLimit = requiredPart(6), labels = parts.slice(7);
  return { id, running: running === "true", runtime, nanoCpus, memory, memorySwap, pidsLimit, labels };
}

export async function inspectOwnedResource(kind: "network" | "volume", name: string, workspaceId: string, role: string): Promise<void> {
  const format = "{{index .Labels \"dim.managed\"}}|{{index .Labels \"dim.workspace-id\"}}|{{index .Labels \"dim.resource\"}}|{{index .Labels \"dim.workspace-schema\"}}";
  const result = await runCommand("docker", [kind, "inspect", name, "--format", format]);
  const labels = result.stdout.trim().split("|");
  const expected = ["true", workspaceId, role, "10"];
  if (labels.some((value, index) => value !== expected[index])) throw new TypeError(`${kind} ${name} ownership labels differ`);
}

export async function managedResourceSnapshot(): Promise<ReadonlySet<string>> {
  const entries: string[] = [];
  for (const [kind, format] of [["container", "{{.Names}}"], ["network", "{{.Name}}"], ["volume", "{{.Name}}"]] as const) {
    const result = await runCommand("docker", [kind, "ls", ...(kind === "container" ? ["--all"] : []), "--filter", "label=dim.managed=true", "--format", format]);
    for (const name of result.stdout.split("\n").map((value) => value.trim()).filter(Boolean)) entries.push(`${kind}:${name}`);
  }
  return new Set(entries);
}

export async function resourceExists(kind: "container" | "network" | "volume", name: string): Promise<boolean> {
  return (await runCommand("docker", [kind, "inspect", name], { acceptFailure: true })).exitCode === 0;
}
