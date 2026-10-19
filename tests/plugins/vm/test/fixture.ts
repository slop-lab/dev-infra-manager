import { expect } from "vitest";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/workspace/models.js";
import { parseVmHostConfig } from "../../../../plugin-vm/src/config.js";
const id = "12345678-1234-1234-1234-123456789abc";
export const config = parseVmHostConfig({ schemaVersion: 1, project: "dim", storagePool: "vm", network: "vmbr0",
  guest: { cpuCount: 4, memory: "8GiB", disk: "32GiB" }, cgroupRoot: "/sys/fs/cgroup/dim", incusSocket: "/var/lib/incus/unix.socket" });
export function workspace(changes: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return { schemaVersion: 10, id, name: "dev", source: { url: "/tmp/repo", ref: "HEAD", commit: "b".repeat(40) }, runtime: "vm",
    image: "a".repeat(64), resources: { cpuCount: "1.5", memory: "10g", pidsLimit: "512" }, git: { name: "Developer", email: "dev@example.test" },
    initialized: false, phase: "creating", createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z", ...changes };
}
export class FakeIncus implements StreamingCommandRunner {
  calls: string[][] = [];
  exists = false; running = false; foreign = false; instanceId = id;
  async run(command: string, args: string[], _options?: RunOptions): Promise<CommandResult> {
    expect(command).toBe("incus");
    if (args[0] !== "query") expect(args.slice(0, 2)).toEqual(["--project", "dim"]);
    else expect(args[1]).toContain("?project=dim");
    const op = args[0] === "query" ? args.map((arg, index) => index === 1 ? arg.split("?")[0] ?? arg : arg) : args.slice(2);
    this.calls.push(op);
    let output: unknown = ""; let exitCode = 0; let stderr = "";
    if (op[0] === "query") {
      if (op[1]?.includes("/networks/")) output = { managed: true, type: "bridge", config: { "ipv4.address": "10.72.0.1/24" } };
      else if (!this.exists) { exitCode = 1; stderr = "Instance not found"; }
      else if (op[1]?.endsWith("/state")) output = { status_code: this.running ? 103 : 102, pid: this.running ? 123 : 0 };
      else output = { name: `dim-${this.instanceId}`, type: "virtual-machine", config: { "user.dim.workspace-id": this.foreign ? "other" : this.instanceId,
        "user.dim.owner": "dim-vm-v1", "user.dim.image": "a".repeat(64), "volatile.base_image": "a".repeat(64) } };
    } else if (op[0] === "init") { this.exists = true; this.instanceId = op[2]?.slice(4) ?? id; }
    else if (op[0] === "start") this.running = true;
    else if (op[0] === "stop") this.running = false;
    else if (op[0] === "delete") this.exists = false;
    return { command, args, stdout: typeof output === "string" ? output : JSON.stringify(output), stderr, exitCode };
  }
  async runStreaming(command: string, args: string[], options?: RunOptions): Promise<number> { return (await this.run(command, args, options)).exitCode; }
}
