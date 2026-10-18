import { UserError } from "@slop-lab/dim-core";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import type { WorkspaceEnvironment } from "./workspaceEnvironment.js";

export type WorkspaceResourceLimits = Pick<WorkspaceRecord, "cpuCount" | "memory" | "pidsLimit">;

export type WorkspaceResourceAllocation = {
  readonly outer: WorkspaceResourceLimits;
  readonly agent?: WorkspaceResourceLimits;
};

export type RecommendedWorkspaceResourceAllocation = {
  readonly outer: WorkspaceResourceLimits;
  readonly agent: WorkspaceResourceLimits;
};

export const RECOMMENDED_WORKSPACE_MINIMUMS = {
  cpuCount: "1",
  memory: "1g",
  pidsLimit: "256"
} as const satisfies WorkspaceResourceLimits;

const NANO_CPUS_PER_CPU = 1_000_000_000n;
const BYTES_PER_GIBIBYTE = 1_073_741_824n;
const RECOMMENDED_MINIMUM_PIDS = 256n;
const RESOURCE_INSPECT_FORMAT = "{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.PidsLimit}}";

type ContainerResourceUpdate = {
  readonly runner: StreamingCommandRunner;
  readonly containerId: string;
  readonly limits: WorkspaceResourceLimits;
  readonly action: string;
};

export function allocateWorkspaceResourceBudget(
  environment: "recommended",
  recorded: WorkspaceResourceLimits
): RecommendedWorkspaceResourceAllocation;
export function allocateWorkspaceResourceBudget(
  environment: WorkspaceEnvironment,
  recorded: WorkspaceResourceLimits
): WorkspaceResourceAllocation;
export function allocateWorkspaceResourceBudget(
  environment: WorkspaceEnvironment,
  recorded: WorkspaceResourceLimits
): WorkspaceResourceAllocation {
  if (environment !== "recommended") return { outer: recorded };

  const cpu = parseCpu(recorded.cpuCount);
  const memory = parseMemory(recorded.memory);
  const pids = BigInt(recorded.pidsLimit);
  if (cpu < NANO_CPUS_PER_CPU || memory < BYTES_PER_GIBIBYTE || pids < RECOMMENDED_MINIMUM_PIDS) {
    throw new UserError(
      "recommended workspace resources require at least 1 CPU, 1 GiB memory, and 256 PIDs for two Linux containers"
    );
  }

  const outerCpu = cpu / 4n;
  const outerMemory = memory / 4n;
  const outerPids = pids / 4n;
  return {
    outer: {
      cpuCount: formatCpu(outerCpu),
      memory: outerMemory.toString(),
      pidsLimit: outerPids.toString()
    },
    agent: {
      cpuCount: formatCpu(cpu - outerCpu),
      memory: (memory - outerMemory).toString(),
      pidsLimit: (pids - outerPids).toString()
    }
  };
}

export function workspaceResourceUpdateArgs(limits: WorkspaceResourceLimits, containerId: string): string[] {
  return [
    "update",
    "--cpus", limits.cpuCount,
    "--memory", limits.memory,
    "--memory-swap", limits.memory,
    "--pids-limit", limits.pidsLimit,
    containerId
  ];
}

export async function updateContainerResourceLimits(update: ContainerResourceUpdate): Promise<void> {
  const result = await update.runner.run("docker", workspaceResourceUpdateArgs(update.limits, update.containerId));
  if (result.exitCode !== 0) {
    throw new UserError(`failed to ${update.action}: ${result.stderr.trim()}`);
  }
  const inspected = await update.runner.run("docker", [
    "container", "inspect", update.containerId, "--format", RESOURCE_INSPECT_FORMAT
  ]);
  if (inspected.exitCode !== 0) {
    throw new UserError(`failed to read back ${update.action}: ${inspected.stderr.trim()}`);
  }
  const expected = [
    parseCpu(update.limits.cpuCount),
    parseMemory(update.limits.memory),
    parseMemory(update.limits.memory),
    BigInt(update.limits.pidsLimit)
  ];
  const fields = inspected.stdout.trim().split("|");
  if (fields.length !== expected.length || fields.some((field, index) => {
    if (field === undefined) return true;
    try {
      return BigInt(field) !== expected[index];
    } catch (error) {
      if (error instanceof SyntaxError) return true;
      throw error;
    }
  })) {
    throw new UserError(`Docker did not apply ${update.action} exactly`);
  }
}

export function workspaceResourceBudgetLabels(role: "outer" | "agent"): readonly string[] {
  return ["dim.resource-budget=split-v1", `dim.resource-budget-role=${role}`];
}

function parseCpu(value: string): bigint {
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > 9) {
    throw new UserError("recommended workspace CPU limit supports at most 9 decimal places");
  }
  return BigInt(whole) * NANO_CPUS_PER_CPU + BigInt(fraction.padEnd(9, "0") || "0");
}

function formatCpu(value: bigint): string {
  const whole = value / NANO_CPUS_PER_CPU;
  const fraction = (value % NANO_CPUS_PER_CPU).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function parseMemory(value: string): bigint {
  const match = /^([1-9][0-9]*)([kmgt]?)(i?)(b?)$/i.exec(value);
  if (match === null) throw new UserError("workspace memory limit must be a positive container memory size");
  const amount = match[1];
  const unit = match[2]?.toLowerCase();
  if (amount === undefined || unit === undefined) {
    throw new UserError("workspace memory limit must be a positive container memory size");
  }
  const exponent = ["", "k", "m", "g", "t"].indexOf(unit);
  return BigInt(amount) * (1024n ** BigInt(exponent));
}
