import { stat } from "node:fs/promises";
import { UserError } from "./errors.js";
import type { CiRunnerResources, LifecycleOptions } from "./lifecycleTypes.js";
import { qemuMemoryMiB } from "./qemuCiRunnerLifecycle.js";
import { configuredCiRunnerDefaults } from "./userConfig.js";

export const BUILTIN_CI_RUNNER_DEFAULTS: CiRunnerResources = {
  cpus: "4",
  memory: "8g",
  pidsLimit: "2048"
};

export async function detectCiRunnerKvm(
  probe: () => Promise<void> = async () => {
    const device = await stat("/dev/kvm");
    if (!device.isCharacterDevice()) throw new Error("/dev/kvm is not a character device");
  },
  architecture = process.arch
): Promise<boolean> {
  if (architecture !== "x64") return false;
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}

export function effectiveCiRunnerResources(
  options: LifecycleOptions,
  overrides?: Partial<CiRunnerResources>,
  configured = configuredCiRunnerDefaults()
): { resources: CiRunnerResources; inheritsResources: boolean } {
  const defaults = configured ?? {
    cpus: options.ciRunnerDefaultCpus || BUILTIN_CI_RUNNER_DEFAULTS.cpus,
    memory: options.ciRunnerDefaultMemory || BUILTIN_CI_RUNNER_DEFAULTS.memory,
    pidsLimit: options.ciRunnerDefaultPidsLimit || BUILTIN_CI_RUNNER_DEFAULTS.pidsLimit
  };
  const resources = {
    cpus: overrides?.cpus ?? defaults.cpus,
    memory: overrides?.memory ?? defaults.memory,
    pidsLimit: overrides?.pidsLimit ?? defaults.pidsLimit
  };
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(resources.cpus) || Number(resources.cpus) <= 0) {
    throw new UserError("CI runner CPUs must be a positive number");
  }
  if (!/^[1-9][0-9]*(?:[kmgt]i?b?|[KMGT]i?B?)?$/.test(resources.memory)) {
    throw new UserError("CI runner memory must be a positive container memory size");
  }
  if (!/^[1-9][0-9]*$/.test(resources.pidsLimit)) {
    throw new UserError("CI runner PID limit must be a positive integer");
  }
  return {
    resources,
    inheritsResources: overrides === undefined || Object.values(overrides).every((value) => value === undefined)
  };
}

export function effectiveQemuCiRunnerResources(
  options: LifecycleOptions,
  overrides?: Partial<CiRunnerResources>,
  configured = configuredCiRunnerDefaults()
): { resources: Pick<CiRunnerResources, "cpus" | "memory">; inheritsResources: boolean } {
  if (overrides?.pidsLimit !== undefined) throw new UserError("process limits apply only to the sysbox CI executor");
  const effective = effectiveCiRunnerResources(options, {
    ...(overrides?.cpus === undefined ? {} : { cpus: overrides.cpus }),
    ...(overrides?.memory === undefined ? {} : { memory: overrides.memory })
  }, configured);
  if (!/^[1-9][0-9]*$/.test(effective.resources.cpus)) {
    throw new UserError("QEMU CI runner CPUs must be a positive integer");
  }
  if (qemuMemoryMiB(effective.resources.memory) < 512) {
    throw new UserError("QEMU CI runner memory must be at least 512 MiB");
  }
  return {
    resources: { cpus: effective.resources.cpus, memory: effective.resources.memory },
    inheritsResources: effective.inheritsResources
  };
}
