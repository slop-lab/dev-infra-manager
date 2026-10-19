import { readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { UserError, type CommandRunner, type StreamingCommandRunner, type RunOptions, type WorkspaceResources } from "@slop-lab/dim-host-core/workspace";
import { fingerprint, object, uuid, parseVmHostConfig, type VmHostConfig } from "./config.js";
import type { VmBudget } from "./budget.js";

export interface VmIdentity { source?: { workingDirectory?: string; checkouts?: readonly { directory: string }[] }; id: string; image: string; initialized: boolean; resources: WorkspaceResources }
export interface VmInspection { running: boolean; pid: number }

/** Incus owns the durable root disk and machine definition; DIM owns the UUID labels and admission. */
export class IncusMachines {
  constructor(readonly config: VmHostConfig, readonly runner: StreamingCommandRunner, private readonly budget: VmBudget,
    private readonly cleanupRunner: CommandRunner = runner) {}

  name(record: Pick<VmIdentity, "id">): string { return `dim-${uuid(record.id)}`; }
  async inspect(record: VmIdentity): Promise<VmInspection | undefined> {
    const name = this.name(record);
    const result = await this.runner.run("incus", this.args(["query", `/1.0/instances/${name}`]));
    if (result.exitCode !== 0) {
      if (/not found|does not exist/i.test(result.stderr)) return undefined;
      throw new UserError(`cannot inspect Incus VM: ${result.stderr.trim()}`);
    }
    const instance = object(JSON.parse(result.stdout));
    const config = object(instance.config);
    if (instance.name !== name || instance.type !== "virtual-machine" || config["user.dim.workspace-id"] !== record.id
      || config["user.dim.owner"] !== "dim-vm-v1" || config["user.dim.image"] !== fingerprint(record.image) || config["volatile.base_image"] !== record.image) {
      throw new UserError(`Incus instance '${name}' is not owned by this DIM VM record`);
    }
    const state = object(await this.query(`/1.0/instances/${name}/state`));
    const running = state.status_code === 103;
    if (typeof state.pid !== "number" || !Number.isSafeInteger(state.pid) || state.pid < 0 || (running && state.pid === 0)) throw new UserError("Incus returned invalid QEMU process state");
    return { running, pid: state.pid };
  }

  async create(record: VmIdentity): Promise<void> {
    fingerprint(record.image);
    const current = await this.inspect(record);
    if (current !== undefined) return;
    if (record.initialized) throw new UserError("persistent VM disk is missing; restore an explicit backup or discard the workspace before creating a new VM");
    const { guest } = this.config;
    await this.checked(["init", record.image, this.name(record), "--vm", "--no-profiles", "--storage", this.config.storagePool,
      "--network", this.config.network,
      "--device", `root,size=${guest.disk}`,
      "--config", `limits.cpu=${guest.cpuCount}`, "--config", `limits.memory=${guest.memory}`,
      "--config", "limits.memory.hugepages=false", "--config", "boot.autostart=false",
      "--config", "raw.qemu.conf=[device \"qemu_balloon\"]\nfree-page-reporting = \"on\"",
      "--config", `user.dim.workspace-id=${record.id}`, "--config", "user.dim.owner=dim-vm-v1", "--config", `user.dim.image=${record.image}`]);
    if (await this.inspect(record) === undefined) throw new UserError("created Incus VM is unavailable");
  }

  async start(record: VmIdentity): Promise<void> {
    const actual = await this.require(record);
    try {
      await this.budget.prepare?.({ instance: this.name(record) }, record.resources);
      if (!actual.running) await this.checked(["start", this.name(record)]);
      const running = await this.require(record);
      if (!running.running) throw new UserError("Incus did not start the VM");
      await this.budget.apply({ instance: this.name(record), pid: running.pid }, record.resources);
    } catch (error) {
      // A VM without confirmed host ceilings must not remain running.
      try {
        const failed = await this.inspect(record);
        if (failed?.running) await this.checked(["stop", this.name(record), "--force"], this.cleanupRunner);
      } catch (cleanupError) { throw new AggregateError([error, cleanupError], "VM start failed and stopping the unbounded VM could not be confirmed"); }
      throw error;
    }
  }
  async stop(record: VmIdentity): Promise<void> {
    const actual = await this.inspect(record);
    if (actual?.running) await this.checked(["stop", this.name(record), "--timeout", "30"]);
    await this.budget.release?.(this.name(record));
  }
  async remove(record: VmIdentity, options: { keepData: boolean }): Promise<void> {
    const actual = await this.inspect(record);
    if (actual === undefined) {
      if (options.keepData) throw new UserError("cannot retain a missing persistent VM disk");
      return;
    }
    if (options.keepData) { await this.stop(record); return; }
    await this.checked(["delete", this.name(record), "--force"]);
    await this.budget.release?.(this.name(record));
  }
  async updateAllocation(record: VmIdentity, changes: { cpuCount?: number; memory?: string }): Promise<{ cpuCount: number; memory: string }> {
    const actual = await this.require(record);
    if (actual.running && (changes.cpuCount !== undefined || changes.memory !== undefined)) throw new UserError("stop the VM before changing guest CPU or memory allocation; host ceilings can change while running");
    const instance = object(await this.query(`/1.0/instances/${this.name(record)}`)), current = object(instance.config);
    const cpuCount = changes.cpuCount ?? Number(current["limits.cpu"]), memory = changes.memory ?? current["limits.memory"];
    // Allocation belongs to Incus, independently from core host resource ceilings.
    const checked = parseVmHostConfig({ ...this.config, guest: { ...this.config.guest, cpuCount, memory } }).guest;
    if (changes.cpuCount !== undefined || changes.memory !== undefined) await this.checked(["config", "set", this.name(record), `limits.cpu=${checked.cpuCount}`, `limits.memory=${checked.memory}`]);
    const observed = object(object(await this.query(`/1.0/instances/${this.name(record)}`)).config);
    if (observed["limits.cpu"] !== String(checked.cpuCount) || observed["limits.memory"] !== checked.memory) throw new UserError("Incus did not retain the requested VM guest allocation");
    return { cpuCount: checked.cpuCount, memory: checked.memory };
  }
  async updateResources(record: VmIdentity, resources: WorkspaceResources): Promise<{ recreated: boolean }> {
    const actual = await this.require(record);
    if (actual.running) await this.budget.apply({ instance: this.name(record), pid: actual.pid }, resources);
    return { recreated: false };
  }
  async enforce(record: VmIdentity): Promise<void> {
    const actual = await this.require(record);
    if (!actual.running) throw new UserError("VM is stopped; start it before running commands");
    await this.budget.verify({ instance: this.name(record), pid: actual.pid }, record.resources);
  }
  async exec(record: VmIdentity, command: string[], options: RunOptions = {}): Promise<number> {
    if (command.length === 0 || command.some((argument) => argument.includes("\0"))) throw new UserError("provide a VM command");
    await this.enforce(record);
    return this.runner.runStreaming("incus", this.args(["exec", this.name(record),
      "--cwd", `/workspace${record.source?.workingDirectory ? `/${record.source.workingDirectory}` : ""}`, "--env", "HOME=/home/dim", "--env", "TMPDIR=/mnt/dim-tmp", "--env", "DIM_WORKSPACE_TMPDIR=/mnt/dim-tmp",
      "--mode", options.terminal ? "interactive" : "non-interactive", "--", "runuser", "--user", "dim", "--preserve-environment", "--", ...command]), options);
  }
  async waitForAgent(record: VmIdentity, timeoutMilliseconds = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    for (;;) {
      const result = await this.runner.run("incus", this.args(["exec", this.name(record), "--", "true"]));
      if (result.exitCode === 0) return;
      if (!/VM agent isn.t currently running|connection refused|not connected|Instance is not running/i.test(result.stderr)) throw new UserError(`VM guest readiness failed: ${result.stderr.trim()}`);
      if (Date.now() >= deadline) throw new UserError("VM guest agent did not become ready; verify the reviewed image and Incus agent payload before retrying");
      await setTimeout(250);
    }
  }
  async waitForDocker(record: VmIdentity, timeoutMilliseconds = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    for (;;) {
      const result = await this.runner.run("incus", this.args(["exec", this.name(record), "--", "docker", "info", "--format", "{{.ServerVersion}}"]));
      if (result.exitCode === 0) return;
      if (!/Cannot connect|failed to connect|connection refused|no such file or directory|VM agent isn.t currently running|Instance is not running/i.test(result.stderr)
        || /Command not found|executable file not found/.test(result.stderr)) throw new UserError(`VM guest Docker readiness failed: ${result.stderr.trim()}`);
      if (Date.now() >= deadline) throw new UserError("VM guest Docker did not become ready; configure its guest daemon to start at boot before retrying");
      await setTimeout(250);
    }
  }
  async rootExec(record: VmIdentity, command: string[], options: RunOptions = {}): Promise<void> {
    await this.enforce(record);
    await this.checked(["exec", this.name(record), "--", ...command], this.runner, options);
  }
  async installGuestAsset(record: VmIdentity, asset: { name: string; sourcePath: string; mode: number }): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/.test(asset.name) || !Number.isSafeInteger(asset.mode) || asset.mode < 0 || asset.mode > 0o777) throw new UserError("invalid reviewed guest helper asset");
    await this.enforce(record);
    await this.checked(["file", "push", "--uid", "0", "--gid", "0", "--mode", asset.mode.toString(8), asset.sourcePath,
      `${this.name(record)}/usr/local/bin/${asset.name}`]);
  }
  async seed(record: VmIdentity, directory: string, git: { name: string; email: string }): Promise<void> {
    await this.rootExec(record, ["install", "-d", "-o", "1000", "-g", "1000", "-m", "0755", "/workspace"]);
    const entries = await readdir(directory);
    for (let index = 0; index < entries.length; index += 64) {
      await this.checked(["file", "push", "--recursive", ...entries.slice(index, index + 64).map((entry) => path.join(directory, entry)), `${this.name(record)}/workspace/`]);
    }
    await this.rootExec(record, ["chown", "-R", "1000:1000", "/workspace"]);
    for (const directory of record.source?.checkouts?.map((checkout) => checkout.directory) ?? ["."]) {
      const result = await this.exec(record, ["git", "-C", `/workspace/${directory}`, "config", "--local", "user.name", git.name]);
      if (result !== 0) throw new UserError("could not configure VM checkout Git name");
      if (await this.exec(record, ["git", "-C", `/workspace/${directory}`, "config", "--local", "user.email", git.email]) !== 0) throw new UserError("could not configure VM checkout Git email");
    }
  }
  async hostGateway(record: VmIdentity): Promise<string> {
    await this.require(record);
    const network = object(await this.query(`/1.0/networks/${encodeURIComponent(this.config.network)}`));
    const config = object(network.config);
    const address = config["ipv4.address"];
    if (network.type !== "bridge" || network.managed !== true || typeof address !== "string"
      || !/^([0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}$/.test(address)) throw new UserError("VM requires a managed Incus bridge with an explicit IPv4 gateway");
    const gateway = address.split("/")[0];
    if (gateway === undefined || gateway.split(".").some((part) => Number(part) > 255)) throw new UserError("invalid Incus bridge gateway");
    return gateway;
  }
  async query(endpoint: string): Promise<unknown> {
    const result = await this.checked(["query", endpoint]);
    return JSON.parse(result);
  }
  async checked(args: string[], runner: CommandRunner = this.runner, options?: RunOptions): Promise<string> {
    const result = await runner.run("incus", this.args(args), options);
    if (result.exitCode !== 0) throw new UserError(`Incus ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }
  private args(args: string[]): string[] {
    if (args[0] === "query" && args[1] !== undefined) {
      const endpoint = args[1];
      return ["query", `${endpoint}${endpoint.includes("?") ? "&" : "?"}project=${encodeURIComponent(this.config.project)}`, ...args.slice(2)];
    }
    return ["--project", this.config.project, ...args];
  }
  private async require(record: VmIdentity): Promise<VmInspection> {
    const actual = await this.inspect(record);
    if (actual === undefined) throw new UserError("persistent VM does not exist");
    return actual;
  }
}
