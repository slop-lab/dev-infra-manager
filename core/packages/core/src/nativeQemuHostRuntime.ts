import { UserError } from "./errors.js";
import type { StreamingCommandRunner } from "./types.js";

export class NativeQemuUnavailableError extends UserError {
  readonly name = "NativeQemuUnavailableError";
}

export async function assertNativeQemuKvmAvailable(
  runner: StreamingCommandRunner,
  signal: AbortSignal
): Promise<void> {
  const result = await runner.run("qemu-system-x86_64",
    ["-enable-kvm", "-machine", "none", "-nodefaults", "-display", "none"], { signal });
  if (result.exitCode !== 0) {
    throw new NativeQemuUnavailableError("native QEMU unavailable: functional KVM probe failed");
  }
}

export async function assertNativeQemuRunnerAvailable(
  runner: StreamingCommandRunner,
  runnerImage: string,
  jobImage: string,
  signal: AbortSignal
): Promise<void> {
  const result = await runner.run("docker", ["run", "--rm", "--read-only", "--network", "none",
    "--device", "/dev/kvm:/dev/kvm", "--mount",
    `type=image,src=${jobImage},dst=/run/dim/guest-root`,
    "--entrypoint", "/bin/sh", runnerImage, "-c",
    "test -x /usr/local/bin/dim-native-qemu-run && test -x /run/dim/guest-root/bin/bash && test -d /run/dim/guest-root/dev && test -d /run/dim/guest-root/proc && test -d /run/dim/guest-root/sys && test -d /run/dim/guest-root/run/dim/job && test -d /run/dim/guest-root/workspace && exec qemu-system-x86_64 -enable-kvm -machine none -nodefaults -display none"],
  { signal });
  if (result.exitCode !== 0) {
    throw new NativeQemuUnavailableError("native QEMU runner image is unavailable");
  }
}
