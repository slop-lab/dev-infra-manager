import { mkdir, readFile, realpath, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceResources } from "@slop-lab/dim-host-core/workspace";

export interface VmBudget {
  prepare?(identity: { instance: string }, resources: WorkspaceResources): Promise<void>;
  apply(identity: { instance: string; pid: number }, resources: WorkspaceResources): Promise<void>;
  verify(identity: { instance: string; pid: number }, resources: WorkspaceResources): Promise<void>;
  release?(instance: string): Promise<void>;
}

/** QEMU joins a UUID child of an explicitly delegated subtree; guests never see this authority. */
export class LinuxVmBudget implements VmBudget {
  constructor(private readonly root: string, private readonly procRoot = "/proc") {}

  async configure(identity: { instance: string; pid?: number }, resources: WorkspaceResources): Promise<void> {
    const group = await this.group(identity.instance, true);
    const members = (await readFile(path.join(group, "cgroup.procs"), "utf8")).trim().split(/\s+/).filter(Boolean);
    if (members.some((pid) => pid !== String(identity.pid))) throw new Error("VM cgroup contains an unrelated process");
    const previous = new Map<string, string>();
    for (const file of Object.keys(budgetValues(resources))) previous.set(file, await readFile(path.join(group, file), "utf8"));
    try { for (const [file, value] of Object.entries(budgetValues(resources))) await writeFile(path.join(group, file), value); }
    catch (error) { for (const [file, value] of previous) await writeFile(path.join(group, file), value); throw error; }
  }
  async admit(instance: string, resources: WorkspaceResources, pid: number): Promise<void> {
    const group = await this.group(instance, false);
    if ((await readFile(path.join(group, "cgroup.procs"), "utf8")).trim() !== "") throw new Error("owned VM cgroup is already in use");
    for (const [file, value] of Object.entries(budgetValues(resources))) {
      if ((await readFile(path.join(group, file), "utf8")).trim() !== value) throw new Error("VM launch budget does not match root-owned intent");
    }
    await writeFile(path.join(this.procRoot, String(pid), "oom_score_adj"), "500");
    await writeFile(path.join(group, "cgroup.procs"), String(pid));
  }
  async apply(identity: { instance: string; pid: number }, resources: WorkspaceResources): Promise<void> {
    validateBudgetResources(resources);
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) throw new Error("Incus did not report the VM's QEMU PID");
    const processRoot = path.join(this.procRoot, String(identity.pid));
    const before = startTicks(await readFile(path.join(processRoot, "stat"), "utf8"));
    const command = (await readFile(path.join(processRoot, "cmdline"), "utf8")).split("\0");
    const nameIndex = command.indexOf("-name");
    const name = command[nameIndex + 1]?.split(",")[0];
    const executable = await realpath(path.join(processRoot, "exe"));
    if (nameIndex < 0 || name !== identity.instance || !/^qemu-system-[a-zA-Z0-9_-]+$/.test(path.basename(executable))) {
      throw new Error("Incus PID is not the owned VM's QEMU process");
    }
    const root = await realpath(this.root);
    const controllers = (await readFile(path.join(root, "cgroup.subtree_control"), "utf8")).split(/\s+/);
    if (["cpu", "memory", "pids"].some((controller) => !controllers.includes(controller))) {
      throw new Error("VM host cgroup delegation must enable cpu, memory and pids controllers before use");
    }
    const group = await this.group(identity.instance, true);
    const members = (await readFile(path.join(group, "cgroup.procs"), "utf8")).trim().split(/\s+/).filter(Boolean);
    if (members.some((member) => member !== String(identity.pid))) throw new Error("VM cgroup contains an unrelated process");
    const files = budgetValues(resources);
    const previousOom = await readFile(path.join(processRoot, "oom_score_adj"), "utf8");
    const previous = new Map<string, string>();
    for (const file of Object.keys(files)) previous.set(file, await readFile(path.join(group, file), "utf8"));
    const stable = async () => {
      if (startTicks(await readFile(path.join(processRoot, "stat"), "utf8")) !== before
        || await realpath(path.join(processRoot, "exe")) !== executable) throw new Error("QEMU process identity changed while applying host limits");
    };
    await stable();
    try {
      await writeFile(path.join(processRoot, "oom_score_adj"), "500");
      // Configure the empty child before admitting QEMU. cgroup.procs moves all its threads together.
      for (const [file, value] of Object.entries(files)) { await stable(); await writeFile(path.join(group, file), value); }
      await stable();
      if (!members.includes(String(identity.pid))) await writeFile(path.join(group, "cgroup.procs"), String(identity.pid));
      await stable();
      const membership = await readFile(path.join(processRoot, "cgroup"), "utf8");
      const expected = `0::/${path.relative("/sys/fs/cgroup", group)}`;
      if (!membership.trim().split("\n").includes(expected)) throw new Error("QEMU did not enter its owned host cgroup");
      for (const [file, value] of Object.entries(files)) {
        if ((await readFile(path.join(group, file), "utf8")).trim() !== value) throw new Error(`QEMU host limit '${file}' was not applied`);
      }
    } catch (error) {
      await stable();
      for (const [file, value] of previous) await writeFile(path.join(group, file), value);
      await writeFile(path.join(processRoot, "oom_score_adj"), previousOom);
      throw error;
    }
  }
  async verify(identity: { instance: string; pid: number }, resources: WorkspaceResources): Promise<void> {
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) throw new Error("invalid QEMU process identity");
    const group = await this.group(identity.instance, false);
    const processRoot = path.join(this.procRoot, String(identity.pid));
    const before = startTicks(await readFile(path.join(processRoot, "stat"), "utf8"));
    if ((await readFile(path.join(processRoot, "oom_score_adj"), "utf8")).trim() !== "500") throw new Error("VM host OOM priority changed; start it through DIM before executing commands");
    const expected = `0::/${path.relative("/sys/fs/cgroup", group)}`;
    const membership = await readFile(path.join(processRoot, "cgroup"), "utf8");
    if (!membership.trim().split("\n").includes(expected)) throw new Error("VM host limits are absent; start the VM through DIM before executing commands");
    for (const [file, value] of Object.entries(budgetValues(resources))) {
      if ((await readFile(path.join(group, file), "utf8")).trim() !== value) throw new Error("VM host limits changed; retry after its resource operation completes");
    }
    if (startTicks(await readFile(path.join(processRoot, "stat"), "utf8")) !== before) throw new Error("QEMU process changed while inspecting host limits");
  }
  async release(instance: string): Promise<void> {
    let group: string;
    try { group = await this.group(instance, false); }
    catch (error) { if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return; throw error; }
    if ((await readFile(path.join(group, "cgroup.procs"), "utf8")).trim() !== "") throw new Error("cannot remove a VM cgroup with live processes");
    await rmdir(group);
  }
  private async group(instance: string, create: boolean): Promise<string> {
    if (!/^dim-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instance)) throw new Error("invalid VM cgroup identity");
    const root = await realpath(this.root), target = path.join(root, instance);
    if (create) {
      try { await mkdir(target); }
      catch (error) { if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
    }
    const group = await realpath(target);
    if (path.dirname(group) !== root || group !== target) throw new Error("VM cgroup is outside the configured writable delegation");
    return group;
  }
}

export function budgetValues(resources: WorkspaceResources): Record<string, string> {
  validateBudgetResources(resources);
  return {
    "cpu.max": resources.cpuCount === "unlimited" ? "max 100000" : cpuQuota(resources.cpuCount),
    "memory.max": resources.memory === "unlimited" ? "max" : memoryBytes(resources.memory),
    "pids.max": resources.pidsLimit === "unlimited" ? "max" : resources.pidsLimit
  };
}
function memoryBytes(value: string): string {
  const match = /^([0-9]+)([a-z]*)$/i.exec(value);
  if (!match?.[1] || match[2] === undefined) throw new Error("invalid host memory limit");
  const unit = match[2].toLowerCase();
  const powers: Record<string, number> = { "": 0, b: 0, k: 1, kb: 1, kib: 1, m: 2, mb: 2, mib: 2, g: 3, gb: 3, gib: 3, tb: 4, tib: 4 };
  const power = powers[unit];
  if (power === undefined) throw new Error("unsupported host memory unit");
  const base = unit.endsWith("ib") || unit.length === 1 ? 1024n : 1000n;
  return (BigInt(match[1]) * base ** BigInt(power)).toString();
}
function startTicks(stat: string): string {
  const ticks = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
  if (ticks === undefined || !/^[0-9]+$/.test(ticks)) throw new Error("invalid QEMU process identity");
  return ticks;
}

function cpuQuota(value: string): string {
  const quota = Math.ceil(Number(value) * 100000);
  if (!Number.isSafeInteger(quota) || quota < 1000) throw new Error("VM CPU ceiling must represent a supported finite cgroup quota (minimum 0.01 CPU)");
  return `${quota} 100000`;
}

function validateBudgetResources(value: WorkspaceResources): void {
  if (typeof value.cpuCount !== "string" || typeof value.memory !== "string" || typeof value.pidsLimit !== "string"
    || !(value.cpuCount === "unlimited" || /^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$/.test(value.cpuCount))
    || !(value.memory === "unlimited" || /^[1-9][0-9]*(?:[bkmg]|[kmgt]i?b)?$/i.test(value.memory))
    || !(value.pidsLimit === "unlimited" || /^[1-9][0-9]*$/.test(value.pidsLimit))) throw new Error("invalid VM host resource ceilings");
}
