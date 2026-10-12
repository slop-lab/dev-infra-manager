import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { UserError } from "./errors.js";
import type { RunOptions, StreamingCommandRunner } from "./types.js";

const qmpInput = '{"execute":"qmp_capabilities","id":"caps"}\n'
  + '{"execute":"query-kvm","id":"kvm"}\n'
  + '{"execute":"quit","id":"quit"}\n';
const qemuArgs = ["qemu-system-x86_64", "-enable-kvm", "-machine", "none", "-nodefaults", "-display", "none",
  "-qmp", "stdio"] as const;
const runnerProbeLabel = "dev.dim.native-qemu.readiness";

type CapturedCommand = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type CapturedCommandInput = {
  readonly command: string;
  readonly args: string[];
  readonly options: RunOptions;
};

export class NativeQemuUnavailableError extends UserError {
  readonly name = "NativeQemuUnavailableError";
}

export async function assertNativeQemuKvmAvailable(
  runner: StreamingCommandRunner,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const result = await runCaptured(runner, {
    command: "timeout",
    args: ["-s", "KILL", "5", ...qemuArgs],
    options: { signal: bounded, stdin: Readable.from([qmpInput]) }
  });
  if (bounded.aborted || result.exitCode !== 0 || !successfulKvmProbe(result.stdout)) {
    throw new NativeQemuUnavailableError("native QEMU unavailable: functional KVM probe failed");
  }
}

export async function assertNativeQemuRunnerAvailable(
  runner: StreamingCommandRunner,
  runnerImage: string,
  jobImage: string,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  const probeId = randomUUID();
  const containerName = `dim-native-qemu-probe-${probeId}`;
  const ownershipLabel = `${runnerProbeLabel}=${probeId}`;
  const innerProbe = "test -x /usr/local/bin/dim-native-qemu-run"
    + " && test -x /run/dim/guest-root/bin/bash"
    + " && test -d /run/dim/guest-root/dev"
    + " && test -d /run/dim/guest-root/proc"
    + " && test -d /run/dim/guest-root/sys"
    + " && test -d /run/dim/guest-root/run/dim/job"
    + " && test -d /run/dim/guest-root/workspace"
    + ` && exec ${qemuArgs.join(" ")}`;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  let ready = false;
  try {
    const result = await runCaptured(runner, {
      command: "timeout",
      args: ["-s", "KILL", "10", "docker", "run", "--name", containerName, "--label", ownershipLabel,
        "--pull", "never", "--read-only", "--network", "none", "-i", "--device", "/dev/kvm:/dev/kvm", "--mount",
        `type=image,src=${jobImage},dst=/run/dim/guest-root`, "--entrypoint", "/bin/sh", runnerImage, "-c",
        'exec timeout -s KILL 5 /bin/sh -c "$1"', "dim-native-qemu-readiness", innerProbe],
      options: { signal: bounded, stdin: Readable.from([qmpInput]) }
    });
    ready = !bounded.aborted && result.exitCode === 0 && successfulKvmProbe(result.stdout);
  } finally {
    await cleanupRunnerProbe(runner, containerName, probeId);
  }
  if (!ready) throw new NativeQemuUnavailableError("native QEMU runner image is unavailable");
}

async function cleanupRunnerProbe(
  runner: StreamingCommandRunner,
  containerName: string,
  probeId: string
): Promise<void> {
  const inspect = await runCaptured(runner, {
    command: "timeout",
    args: ["-s", "KILL", "5", "docker", "container", "inspect", "--format",
      `{{.Id}}|{{.Name}}|{{index .Config.Labels "${runnerProbeLabel}"}}`, containerName],
    options: { signal: AbortSignal.timeout(7_000) }
  });
  const fields = inspect.stdout.trim().split("|");
  const containerId = fields[0];
  if (inspect.exitCode !== 0 || fields.length !== 3 || containerId === undefined || !/^[0-9a-f]{64}$/.test(containerId)
    || fields[1] !== `/${containerName}` || fields[2] !== probeId) {
    throw new NativeQemuUnavailableError("native QEMU runner image is unavailable: probe container cleanup ownership failed");
  }
  const removal = await runCaptured(runner, {
    command: "timeout",
    args: ["-s", "KILL", "5", "docker", "container", "rm", "--force", containerId],
    options: { signal: AbortSignal.timeout(7_000) }
  });
  if (removal.exitCode !== 0) {
    throw new NativeQemuUnavailableError("native QEMU runner image is unavailable: probe container cleanup failed");
  }
}

async function runCaptured(
  runner: StreamingCommandRunner,
  input: CapturedCommandInput
): Promise<CapturedCommand> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = "";
  let stderrText = "";
  stdout.setEncoding("utf8");
  stderr.setEncoding("utf8");
  stdout.on("data", (chunk: string) => { stdoutText += chunk; });
  stderr.on("data", (chunk: string) => { stderrText += chunk; });
  const exitCode = await runner.runStreaming(input.command, input.args, { ...input.options, stdout, stderr });
  input.options.signal?.throwIfAborted();
  return { exitCode, stdout: stdoutText, stderr: stderrText };
}

function successfulKvmProbe(stdout: string): boolean {
  if (Buffer.byteLength(stdout) > 64 * 1024) return false;
  const ids: string[] = [];
  try {
    for (const line of stdout.trim().split(/\r?\n/)) {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || Object.hasOwn(value, "error")) return false;
      if (Object.hasOwn(value, "id")) {
        if (Object.keys(value).length !== 2 || !isRecord(value.return)) return false;
        switch (value.id) {
          case "caps":
          case "quit":
            if (Object.keys(value.return).length !== 0) return false;
            break;
          case "kvm":
            if (Object.keys(value.return).length !== 2 || value.return.enabled !== true || value.return.present !== true) return false;
            break;
          default: return false;
        }
        ids.push(value.id);
      } else if (!Object.hasOwn(value, "QMP") && !Object.hasOwn(value, "event")) return false;
    }
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  return ids.join(",") === "caps,kvm,quit";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
