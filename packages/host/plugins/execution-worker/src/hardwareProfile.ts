import type { BackendInput } from "./backend.js";

export const hardwareRunnerLabel = "io.dim.execution.runner-profile";
export const hardwareRunnerProfile = "ubuntu-hardware-v2";

/** Operator-pinned image metadata selects the full OS; candidate input cannot. */
export function requireHardwareProfile(value: unknown, descriptor: Pick<BackendInput["grant"]["descriptor"],
  "runnerBaseImage" | "jobImage" | "bounds">): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (value !== hardwareRunnerProfile) throw new Error("unknown trusted QEMU runner profile");
  if (descriptor.runnerBaseImage !== descriptor.jobImage || BigInt(descriptor.bounds.memoryBytes) < 20n * 1024n ** 3n
    || Number(descriptor.bounds.cpu) < 4 || Number(descriptor.bounds.wallClockSeconds) < 10800) {
    throw new Error("Ubuntu hardware profile requires the identical pinned runner/job image, 4 CPU, 20 GiB and a three-hour budget");
  }
  return true;
}
