import { describe, expect, it } from "vitest";
import { IncusMachines } from "../../../../packages/host/plugins/vm/src/incus.js";
import { IncusWorkspaceRuntime } from "../../../../packages/host/plugins/vm/src/runtime.js";
import { budgetValues, type VmBudget } from "../../../../packages/host/plugins/vm/src/budget.js";
import { config, FakeIncus, workspace } from "./fixture.js";
import { parseVmHostConfig } from "../../../../packages/host/plugins/vm/src/config.js";
import type { StreamingCommandRunner } from "../../../../packages/host/core/src/types.js";

const id = "12345678-1234-1234-1234-123456789abc";
function fixture(budget: VmBudget = { apply: async () => {}, verify: async () => {} }) {
  const runner = new FakeIncus();
  return { runner, machines: new IncusMachines(config, runner, budget) };
}

describe("Incus VM workspace runtime", () => {
  it("pins the image and owns a VM root disk without inherited devices or host sockets", async () => {
    const { runner, machines } = fixture();
    await machines.create(workspace());
    const create = runner.calls.find((call) => call[0] === "init");
    expect(create).toContain("--vm"); expect(create).toContain("--no-profiles");
    expect(create).toContain("limits.cpu=4"); expect(create).toContain("limits.memory=8GiB");
    expect(create).toContain("boot.autostart=false"); expect(create).toContain("limits.memory.hugepages=false");
    expect(create?.join(" ")).not.toMatch(/source=\/|proxy|unix\.socket|limits.cpu.allowance/);
    expect(await machines.hostGateway(workspace())).toBe("10.72.0.1");
  });
  it("retains disks across recreate and rejects missing initialized storage", async () => {
    const { runner, machines } = fixture();
    const record = workspace();
    await machines.create(record); await machines.startReady(record);
    const initialized = { ...record, initialized: true };
    await machines.remove(initialized, { keepData: true });
    await machines.create(initialized); await machines.startReady(initialized);
    expect(runner.calls.filter((call) => call[0] === "init")).toHaveLength(1);
    expect(runner.calls.filter((call) => call[0] === "delete")).toHaveLength(0);
    runner.exists = false;
    await expect(machines.create(initialized)).rejects.toThrow("persistent VM disk is missing");
  });
  it("fails closed on foreign identities before start or delete", async () => {
    const { runner, machines } = fixture(); runner.exists = true; runner.foreign = true;
    await expect(machines.startReady(workspace())).rejects.toThrow("not owned");
    await expect(machines.abortStart(workspace())).rejects.toThrow("not owned");
    await expect(machines.remove(workspace(), { keepData: false })).rejects.toThrow("not owned");
    expect(runner.calls.every((call) => call[0] === "query")).toBe(true);
  });
  it("enforces host ceilings separately from guest allocation and stops an unbounded VM", async () => {
    const calls: unknown[] = [];
    const { runner, machines } = fixture({ verify: async () => {}, apply: async (...args) => { calls.push(args); throw new Error("cgroup delegation denied"); } });
    await machines.create(workspace());
    await expect(machines.startReady(workspace())).rejects.toThrow("cgroup delegation denied");
    expect(calls).toEqual([[{ instance: `dim-${id}`, pid: 123 }, workspace().resources, expect.objectContaining({ signal: expect.any(AbortSignal) })]]);
    expect(runner.running).toBe(false);
    expect(runner.calls).toContainEqual(["stop", `dim-${id}`, "--force"]);
  });
  it("confirms force-stop state before releasing a failed-start budget", async () => {
    const releases: string[] = [];
    const runner = new FakeIncus(); runner.exists = true; runner.running = true;
    const machines = new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {},
      release: async (instance) => { expect(runner.running).toBe(false); releases.push(instance); } });
    await machines.abortStart(workspace());
    expect(releases).toEqual([`dim-${id}`]);
  });
  it("uses independent cleanup inspection and budget release after the operation runner is cancelled", async () => {
    const cleanup = new FakeIncus(); cleanup.exists = true; cleanup.running = true;
    const cancelled: StreamingCommandRunner = {
      async run() { throw new DOMException("operation cancelled", "AbortError"); },
      async runStreaming() { throw new DOMException("operation cancelled", "AbortError"); }
    };
    const releases: string[] = [];
    const machines = new IncusMachines(config, cancelled, { apply: async () => {}, verify: async () => {} }, cleanup,
      { apply: async () => {}, verify: async () => {}, release: async (instance) => { expect(cleanup.running).toBe(false); releases.push(instance); } });
    await machines.abortStart(workspace());
    expect(cleanup.calls).toContainEqual(["stop", `dim-${id}`, "--force"]);
    expect(releases).toEqual([`dim-${id}`]);
  });
  it("fails rollback when Incus reports force-stop success but the VM remains running", async () => {
    class IgnoredForceStop extends FakeIncus {
      override async run(command: string, args: string[], options?: import("../../../../packages/host/core/src/types.js").RunOptions) {
        if (args.includes("stop") && args.includes("--force")) {
          this.calls.push(args.slice(2)); return { command, args, stdout: "", stderr: "", exitCode: 0 };
        }
        return super.run(command, args, options);
      }
    }
    let released = false;
    const runner = new IgnoredForceStop(); runner.exists = true; runner.running = true;
    const machines = new IncusMachines(config, runner, { apply: async () => {}, verify: async () => {}, release: async () => { released = true; } });
    await expect(machines.abortStart(workspace())).rejects.toThrow("still running");
    expect(released).toBe(false);
  });
  it("rejects live guest allocation changes before Incus can partially apply unsupported memory hotplug", async () => {
    const { runner, machines } = fixture(); await machines.create(workspace()); await machines.startReady(workspace());
    await expect(machines.updateAllocation(workspace(), { cpuCount: 8, memory: "16GiB" })).rejects.toThrow("stop the VM");
    expect(runner.calls.some((call) => call[0] === "config")).toBe(false);
  });
  it("uses one exec path for streams and does not wrap arbitrary commands in a shell", async () => {
    const { runner, machines } = fixture(); await machines.create(workspace()); await machines.startReady(workspace());
    const runtime = new IncusWorkspaceRuntime(machines);
    expect(await runtime.exec(workspace(), ["printf", "%s", "$(dangerous)"])).toBe(0);
    expect(runner.calls.at(-1)?.slice(-4)).toEqual(["--", "printf", "%s", "$(dangerous)"]);
    await expect(runtime.connect(workspace(), 65536)).rejects.toThrow("invalid VM forwarding port");
  });
  it("rejects floating image aliases before creating anything", async () => {
    const { runner, machines } = fixture();
    await expect(machines.create(workspace({ image: "images:ubuntu/24.04" }))).rejects.toThrow("exact local Incus");
    expect(runner.calls).toHaveLength(0);
  });
});
describe("independent VM host budgets", () => {
  it("maps CPU, memory and task ceilings and unlimited to cgroup v2 values", () => {
    expect(budgetValues(workspace().resources)).toEqual({ "cpu.max": "150000 100000", "memory.max": "10737418240", "pids.max": "512" });
    expect(budgetValues({ cpuCount: "unlimited", memory: "unlimited", pidsLimit: "unlimited" })).toEqual({ "cpu.max": "max 100000", "memory.max": "max", "pids.max": "max" });
  });
  it("rejects guest allocations and unknown host settings rather than accepting profiles silently", () => {
    expect(() => parseVmHostConfig({ ...config, guest: { ...config.guest, cpuCount: 0 } })).toThrow();
    expect(() => parseVmHostConfig({ ...config, devices: { socket: "/var/run/docker.sock" } })).toThrow();
  });
});
