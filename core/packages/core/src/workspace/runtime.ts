import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UserError } from "../errors.js";
import type { CommandResult, CommandRunner, RunOptions, StreamingCommandRunner } from "../types.js";
import type { WorkspaceRecord, WorkspaceResources } from "./models.js";
import type { WorkspaceConnectOptions } from "./service.js";
import { validateWorkspacePort, workspacePortBridge, workspacePortBridgeMarker, workspacePortCleanup } from "./portBridge.js";

export interface WorkspaceRuntimeInspection {
  id: string;
  running: boolean;
}

/** Docker resources are named by immutable identity, never by a reusable display name. */
export function workspaceRuntimeResources(record: Pick<WorkspaceRecord, "id">) {
  const prefix = `dim-workspace-${createHash("sha256").update(record.id).digest("hex").slice(0, 24)}`;
  return {
    container: prefix,
    network: prefix,
    home: `${prefix}-home`,
    checkout: `${prefix}-checkout`,
    docker: `${prefix}-docker`,
    tmp: `${prefix}-tmp`
  };
}

/** Owns runtime resources only. The application owns records, Git acquisition and locks. */
export class ContainerWorkspaceRuntime {
  constructor(private readonly runner: StreamingCommandRunner, private readonly cleanupRunner: CommandRunner = runner) {}

  async hostGateway(record: WorkspaceRecord): Promise<string> {
    await this.require(record);
    const network = await this.inspectResource("network", workspaceRuntimeResources(record).network);
    if (network === undefined) throw new UserError("workspace service network is missing");
    assertOwned(network.Labels, record, "network");
    for (const raw of array(object(network.IPAM).Config)) {
      const gateway = object(raw).Gateway;
      if (typeof gateway === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway)
        && gateway.split(".").every((part) => Number(part) <= 255)) return gateway;
    }
    throw new UserError("workspace service network has no IPv4 host gateway");
  }

  async inspect(record: WorkspaceRecord): Promise<WorkspaceRuntimeInspection | undefined> {
    const resources = workspaceRuntimeResources(record);
    const container = await this.inspectResource("container", resources.container);
    if (container === undefined) return undefined;
    const config = object(container.Config);
    const host = object(container.HostConfig);
    assertOwned(config.Labels, record, "container");
    if (config.Image !== record.image || host.Runtime !== "sysbox-runc" || host.Privileged !== false || host.OomScoreAdj !== 500
      || array(host.Devices).length !== 0 || array(host.CapAdd).length !== 0
      || array(host.SecurityOpt).length !== 0 || array(host.Binds).length !== 0
      || Object.keys(object(host.PortBindings)).length !== 0) {
      throw new UserError(`workspace '${record.name}' container configuration conflicts with its isolated runtime`);
    }
    const mounts = new Map<string, string>([
      ["/home/dim", resources.home], ["/workspace", resources.checkout], ["/var/lib/docker", resources.docker],
      ["/mnt/dim-tmp", resources.tmp]
    ]);
    for (const raw of array(container.Mounts)) {
      const mount = object(raw);
      if (mount.Type !== "volume" || mount.RW !== true || typeof mount.Destination !== "string"
        || mount.Name !== mounts.get(mount.Destination)) {
        throw new UserError(`workspace '${record.name}' has an unexpected runtime mount`);
      }
      mounts.delete(mount.Destination);
    }
    if (mounts.size !== 0 || host.NetworkMode !== resources.network
      || Object.keys(object(object(container.NetworkSettings).Networks)).some((name) => name !== resources.network)) {
      throw new UserError(`workspace '${record.name}' runtime storage or network changed`);
    }
    const state = object(container.State);
    if (typeof container.Id !== "string" || typeof state.Running !== "boolean") {
      throw new UserError("Docker returned an invalid workspace inspection");
    }
    return { id: container.Id, running: state.Running };
  }

  /** Creates a stopped container. Existing persistent data is never deleted on failure. */
  async create(record: WorkspaceRecord): Promise<void> {
    const resources = workspaceRuntimeResources(record);
    // Check the complete existing set before creating anything. A retained
    // workspace must never substitute an empty volume for missing user data.
    for (const role of ["home", "checkout", "docker"] as const) {
      const existing = await this.inspectResource("volume", resources[role]);
      if (existing !== undefined) assertOwned(existing.Labels, record, role);
      else if (record.initialized) throw new UserError(`workspace '${record.name}' retained ${role} storage is missing; preserve its remaining data before recreating it`);
    }
    const network = await this.inspectResource("network", resources.network);
    if (network !== undefined) assertOwned(network.Labels, record, "network");
    const existingContainer = await this.inspect(record);
    if (existingContainer !== undefined) return;
    for (const role of ["home", "checkout", "docker", "tmp"] as const) {
      await this.ensureResource("volume", resources[role], record, role);
    }
    await this.ensureResource("network", resources.network, record, "network");
    await this.checked([
      "create", "--name", resources.container, "--network", resources.network,
      "--runtime", "sysbox-runc",
      "--oom-score-adj", "500",
      ...resourceArguments(record.resources),
      ...(["home", "checkout", "docker", "tmp"] as const).flatMap((role) => [
        "--mount", `type=volume,source=${resources[role]},target=${{ home: "/home/dim", checkout: "/workspace", docker: "/var/lib/docker", tmp: "/mnt/dim-tmp" }[role]}`
      ]),
      ...labelArguments(record, "container"),
      "--env", `DIM_GIT_USER_NAME=${record.git.name}`, "--env", `DIM_GIT_USER_EMAIL=${record.git.email}`,
      "--env", "DIM_WORKSPACE_TMPDIR=/mnt/dim-tmp",
      "--entrypoint", "/sbin/tini", "--", record.image,
      "--", "/usr/local/bin/dim-agent-entrypoint", "sleep", "infinity"
    ]);
    await this.require(record);
    await this.assertResourceLimits(record, record.resources);
  }

  async start(record: WorkspaceRecord): Promise<void> {
    const container = await this.require(record);
    if (!container.running) await this.checked(["start", container.id]);
    const signal = AbortSignal.timeout(60_000);
    while (!signal.aborted) {
      const ready = await this.runner.run("docker", ["exec", container.id, "sh", "-c",
        'test -f "$1" && test "$(cat "$1")" = "$(awk \'{print $22}\' /proc/1/stat) $(readlink /proc/self/ns/pid)" && docker info',
        "dim-workspace-ready", "/run/dim-workspace.ready"], { signal });
      if (ready.exitCode === 0) return;
      if (!(await this.require(record)).running) {
        const logs = await this.runner.run("docker", ["logs", "--tail", "40", container.id]);
        throw new UserError(`workspace '${record.name}' stopped during boot: ${(logs.stderr || logs.stdout).slice(-8192)}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    throw new UserError(`workspace '${record.name}' boot services and nested Docker engine did not become ready within 60 seconds`);
  }

  async stop(record: WorkspaceRecord): Promise<void> {
    const container = await this.inspect(record);
    if (container?.running) await this.checked(["stop", container.id]);
  }

  /** Copies an acquired checkout once, without binding the source host path into the workspace. */
  async seed(record: WorkspaceRecord, directory: string): Promise<void> {
    const container = await this.requireRunning(record);
    await this.checked(["exec", "--user", "root", container.id, "sh", "-c",
      'test -z "$(ls -A /workspace)" || { echo "workspace checkout is already populated; preserving its data" >&2; exit 1; }']);
    // Docker's archive-copy API cannot inspect Sysbox rootfs paths reliably on
    // all supported daemons. Transfer through exec, without exposing a host mount.
    const temporary = await mkdtemp(path.join(tmpdir(), "dim-workspace-seed-"));
    try {
      const archive = path.join(temporary, "checkout.tar");
      const packed = await this.runner.run("tar", ["--create", "--file", archive, "--directory", path.resolve(directory), "."]);
      if (packed.exitCode !== 0) throw new UserError(`cannot package workspace checkout: ${packed.stderr.trim()}`);
      const input = createReadStream(archive);
      try {
        const copied = await this.runner.runStreaming("docker", ["exec", "--interactive", "--user", "root", container.id,
          "tar", "--extract", "--file", "-", "--directory", "/workspace"], { stdin: input });
        if (copied !== 0) throw new UserError("cannot seed workspace checkout; existing data was preserved");
      } finally {
        input.destroy();
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    await this.checked(["exec", "--user", "root", container.id,
      "chown", "-R", "--no-dereference", "dim:dim", "/workspace"]);
    for (const [key, value] of [["user.name", record.git.name], ["user.email", record.git.email]] as const) {
      const result = await this.run(record, ["git", "config", "--local", key, value]);
      if (result.exitCode !== 0) throw new UserError(`cannot configure workspace Git identity: ${result.stderr.trim()}`);
    }
  }

  async updateResources(record: WorkspaceRecord, resources: WorkspaceResources): Promise<{ recreated: boolean }> {
    const container = await this.require(record);
    // Docker CLI treats zero memory/CPU during update as "unchanged". Removing
    // an existing limit therefore requires replacement, with all data retained.
    if ((Object.keys(resources) as Array<keyof WorkspaceResources>)
      .some((key) => resources[key] === "unlimited" && record.resources[key] !== "unlimited")) {
      const updated = { ...record, resources };
      try {
        await this.remove(record, { keepData: true });
        await this.create(updated);
        if (container.running) await this.start(updated);
      } catch (error) {
        try {
          await this.remove(updated, { keepData: true });
          await this.create(record);
          if (container.running) await this.start(record);
        } catch (rollbackError) {
          throw resourceRollbackError(record, error, rollbackError);
        }
        throw error;
      }
      return { recreated: true };
    }
    try {
      await this.checked(["update", ...resourceArguments(resources), container.id]);
      await this.assertResourceLimits(record, resources);
    } catch (error) {
      try {
        await this.checked(["update", ...resourceArguments(record.resources), container.id]);
        await this.assertResourceLimits(record, record.resources);
      } catch (rollbackError) {
        throw resourceRollbackError(record, error, rollbackError);
      }
      throw error;
    }
    return { recreated: false };
  }

  async remove(record: WorkspaceRecord, options: { keepData: boolean }): Promise<void> {
    const resources = workspaceRuntimeResources(record);
    const container = await this.inspect(record);
    if (container !== undefined) await this.checked(["rm", "--force", container.id]);
    if (!options.keepData) {
      await this.removeResource("network", resources.network, record, "network");
      for (const role of ["home", "checkout", "docker", "tmp"] as const) {
        await this.removeResource("volume", resources[role], record, role);
      }
    }
  }

  async run(record: WorkspaceRecord, command: string[], options: RunOptions = {}): Promise<CommandResult> {
    const container = await this.requireRunning(record);
    return this.runner.run("docker", this.execArguments(container.id, command, options), options);
  }

  async exec(record: WorkspaceRecord, command: string[], options: RunOptions = {}): Promise<number> {
    const container = await this.requireRunning(record);
    return this.runner.runStreaming("docker", this.execArguments(container.id, command, options), options);
  }

  async connect(record: WorkspaceRecord, port: number, options: WorkspaceConnectOptions = {}): Promise<number> {
    validateWorkspacePort(port);
    const container = await this.requireRunning(record);
    const token = randomUUID();
    let exitCode: number | undefined;
    try {
      exitCode = await this.runner.runStreaming("docker", this.execArguments(container.id, [
        "node", "--input-type=commonjs", "-e", workspacePortBridge, String(port), workspacePortBridgeMarker, token
      ], options), options);
      return exitCode;
    } finally {
      // A cancelled Docker CLI does not reliably terminate its exec process.
      // Cleanup has its own short lifetime, independent of the cancelled request.
      if (exitCode !== 0 || options.signal?.aborted) {
        const cleanup = await this.cleanupRunner.run("docker", [
          "exec", "--user", "dim", container.id, "node", "--input-type=commonjs", "-e", workspacePortCleanup, token
        ], { signal: AbortSignal.timeout(3000) });
        if (cleanup.exitCode !== 0 && !/no such container|container .* is not running/i.test(cleanup.stderr)) {
          throw new UserError(`workspace '${record.name}' connection cleanup could not be confirmed: ${cleanup.stderr.trim()}`);
        }
      }
    }
  }

  private execArguments(container: string, command: string[], options: RunOptions): string[] {
    if (command.length === 0) throw new UserError("workspace exec requires a command");
    return ["exec", "--user", "dim", "--workdir", "/workspace",
      ...(options.stdin || options.terminal ? ["--interactive"] : []),
      ...(options.terminal ? ["--tty"] : []), container, ...command];
  }

  private async require(record: WorkspaceRecord): Promise<WorkspaceRuntimeInspection> {
    const container = await this.inspect(record);
    if (container === undefined) throw new UserError(`workspace '${record.name}' container does not exist`);
    return container;
  }

  private async requireRunning(record: WorkspaceRecord): Promise<WorkspaceRuntimeInspection> {
    const container = await this.require(record);
    if (!container.running) throw new UserError(`workspace '${record.name}' is stopped; start it before running commands`);
    return container;
  }

  private async inspectResource(kind: string, name: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.runner.run("docker", [kind, "inspect", name, "--format", "{{json .}}"]);
    if (result.exitCode !== 0) {
      if (/no such (?:container|volume|network|object)\b|\bnot found\b/i.test(result.stderr)) return undefined;
      throw new UserError(`cannot inspect Docker ${kind} '${name}': ${result.stderr.trim()}`);
    }
    try {
      return object(JSON.parse(result.stdout));
    } catch (error) {
      throw new UserError(`Docker returned an invalid ${kind} inspection`, { cause: error });
    }
  }

  private async ensureResource(kind: string, name: string, record: WorkspaceRecord, role: string): Promise<void> {
    let resource = await this.inspectResource(kind, name);
    if (resource === undefined) {
      await this.checked([kind, "create", ...labelArguments(record, role), name]);
      resource = await this.inspectResource(kind, name);
    }
    if (resource === undefined) throw new UserError(`created Docker ${kind} '${name}' is unavailable`);
    assertOwned(resource.Labels, record, role);
  }

  private async removeResource(kind: string, name: string, record: WorkspaceRecord, role: string): Promise<void> {
    const resource = await this.inspectResource(kind, name);
    if (resource === undefined) return;
    assertOwned(resource.Labels, record, role);
    await this.checked([kind, "rm", name]);
  }

  private async checked(args: string[]): Promise<CommandResult> {
    const result = await this.runner.run("docker", args);
    if (result.exitCode !== 0) throw new UserError(`Docker ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  }

  private async assertResourceLimits(record: WorkspaceRecord, expected: WorkspaceResources): Promise<void> {
    const container = await this.inspectResource("container", workspaceRuntimeResources(record).container);
    const limits = object(container?.HostConfig);
    const cpu = expected.cpuCount === "unlimited" ? 0n : cpuNanoseconds(expected.cpuCount);
    const memory = expected.memory === "unlimited" ? 0n : memoryBytes(expected.memory);
    const pids = expected.pidsLimit === "unlimited" ? -1n : BigInt(expected.pidsLimit);
    if (String(limits.NanoCpus) !== cpu.toString() || (memory === 0n
      ? limits.Memory !== 0 && limits.Memory !== -1 : String(limits.Memory) !== memory.toString())
      || (pids === -1n ? limits.PidsLimit !== null && limits.PidsLimit !== undefined
        && limits.PidsLimit !== 0 && limits.PidsLimit !== -1 : String(limits.PidsLimit) !== pids.toString())
      || (memory === 0n ? limits.MemorySwap !== -1 && limits.MemorySwap !== 0
        : String(limits.MemorySwap) !== memory.toString())) {
      throw new UserError(`workspace '${record.name}' runtime resource limits differ from the requested budget: ${JSON.stringify({
        cpu: limits.NanoCpus, memory: limits.Memory, swap: limits.MemorySwap, pids: limits.PidsLimit
      })}`);
    }
  }
}

function resourceArguments(resources: WorkspaceResources): string[] {
  return ["--cpus", resources.cpuCount === "unlimited" ? "0" : resources.cpuCount,
    "--memory", resources.memory === "unlimited" ? "0" : resources.memory,
    "--memory-swap", resources.memory === "unlimited" ? "-1" : resources.memory,
    "--pids-limit", resources.pidsLimit === "unlimited" ? "-1" : resources.pidsLimit];
}

function resourceRollbackError(record: WorkspaceRecord, error: unknown, rollbackError: unknown): UserError {
  return new UserError(`workspace '${record.name}' resource update and rollback failed; inspect the runtime before continuing`, {
    cause: new AggregateError([error, rollbackError])
  });
}

function cpuNanoseconds(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > 9 && /[1-9]/.test(fraction.slice(9))) {
    throw new UserError("CPU precision must not exceed one nanosecond per CPU second");
  }
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.slice(0, 9).padEnd(9, "0"));
}

function memoryBytes(value: string): bigint {
  const match = /^(\d+)([bkmgt]?)(?:i?b)?$/i.exec(value);
  if (match === null) throw new UserError("invalid workspace memory budget");
  return BigInt(match[1]!) * 1024n ** BigInt(Math.max(0, "bkmgt".indexOf(match[2]!.toLowerCase())));
}

function labels(record: WorkspaceRecord, role: string): Record<string, string> {
  return { "dim.managed": "true", "dim.workspace-id": record.id, "dim.resource": role, "dim.workspace-schema": "10" };
}

function labelArguments(record: WorkspaceRecord, role: string): string[] {
  return Object.entries(labels(record, role)).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

function assertOwned(value: unknown, record: WorkspaceRecord, role: string): void {
  const actual = object(value);
  if (Object.entries(labels(record, role)).some(([key, expected]) => actual[key] !== expected)) {
    throw new UserError(`workspace '${record.name}' ${role} ownership conflicts with its recorded identity`);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new UserError("invalid Docker inspection object");
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new UserError("invalid Docker inspection list");
  return value;
}
