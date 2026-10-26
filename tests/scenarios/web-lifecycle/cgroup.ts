export type CgroupLevel = {
  readonly path: string;
  readonly cpuQuota: string;
  readonly cpuPeriod: string;
  readonly memory: string;
  readonly pids: string;
};

export type RequestedKernelLimits = {
  readonly cpu: string;
  readonly memory: string;
  readonly pids: string;
};

export const CGROUP_READ_COMMAND = ["sh", "-c", [
  "relative=$(awk -F: '$1 == \"0\" { print $3 }' /proc/self/cgroup)",
  "relative=${relative%/}",
  "current=/sys/fs/cgroup$relative",
  "while :; do",
  "cpu=$(cat \"$current/cpu.max\")",
  "memory=$(cat \"$current/memory.max\")",
  "pids=$(cat \"$current/pids.max\")",
  "shown=${current#/sys/fs/cgroup}; [ -n \"$shown\" ] || shown=/",
  "printf '%s|%s|%s|%s\\n' \"$shown\" \"$cpu\" \"$memory\" \"$pids\"",
  "[ \"$current\" = /sys/fs/cgroup ] && break",
  "current=$(dirname \"$current\")",
  "case \"$current\" in /sys/fs/cgroup*) ;; *) exit 1 ;; esac",
  "done"
].join("\n")] as const;

export function parseCgroupReadback(output: string): readonly CgroupLevel[] {
  return output.trim().split("\n").filter(Boolean).map((line) => {
    const [path, cpu, memory, pids] = line.split("|");
    const [cpuQuota, cpuPeriod] = cpu?.split(" ") ?? [];
    if (path === undefined || cpuQuota === undefined || cpuPeriod === undefined || memory === undefined || pids === undefined) {
      throw new TypeError("invalid cgroup v2 readback");
    }
    return { path, cpuQuota, cpuPeriod, memory, pids };
  });
}

function memoryBytes(value: string): string {
  const match = /^(\d+)([bkmgt]?)(?:i?b)?$/i.exec(value);
  if (match === null) throw new TypeError("invalid memory limit");
  const amount = match[1], unit = match[2];
  if (amount === undefined || unit === undefined) throw new TypeError("invalid memory limit");
  return (BigInt(amount) * 1024n ** BigInt(Math.max(0, "bkmgt".indexOf(unit.toLowerCase())))).toString();
}

function cpuMatches(level: CgroupLevel, requested: string): boolean {
  if (requested === "unlimited") return level.cpuQuota === "max";
  if (level.cpuQuota === "max") return false;
  const [whole = "0", fraction = ""] = requested.split(".");
  const nanoCpus = BigInt(whole) * 1_000_000_000n + BigInt(fraction.slice(0, 9).padEnd(9, "0"));
  return BigInt(level.cpuQuota) * 1_000_000_000n === BigInt(level.cpuPeriod) * nanoCpus;
}

export function kernelLimitsMatch(levels: readonly CgroupLevel[], requested: RequestedKernelLimits): boolean {
  const memory = requested.memory === "unlimited" ? "max" : memoryBytes(requested.memory);
  const pids = requested.pids === "unlimited" ? "max" : requested.pids;
  return levels.some((level) => cpuMatches(level, requested.cpu) && level.memory === memory && level.pids === pids);
}
