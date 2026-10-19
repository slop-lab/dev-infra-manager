import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  ControlPlaneDockerExecutionError,
  ControlPlaneDockerUncertainError,
  type ControlPlaneDockerCommand,
  type ControlPlaneDockerCommandResult,
  type ControlPlaneDockerRunner
} from "./controlPlaneDockerTypes.js";
import { resolveTrustedSystemDockerExecutable } from "./trustedDockerExecutable.js";

const terminationGraceMilliseconds = 1_000;
const trustedDockerPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export class ProcessControlPlaneDockerRunner implements ControlPlaneDockerRunner {
  private readonly executable: string;

  constructor(executable?: string) {
    this.executable = executable ?? resolveTrustedSystemDockerExecutable();
  }

  async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...command.args], {
        detached: true,
        env: { ...process.env, PATH: trustedDockerPath },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let failure: "limit" | "timeout" | undefined;
      let settled = false;
      let childClosed = false;

      const stop = (reason: "limit" | "timeout"): void => {
        if (failure !== undefined) return;
        failure = reason;
        terminateProcessTree(child.pid, () => childClosed).then(
          () => finish(new ControlPlaneDockerExecutionError(
            reason === "limit" ? "Docker command output exceeded its limit" : "Docker command timed out"
          )),
          (error: unknown) => finish(error instanceof ControlPlaneDockerUncertainError
            ? error
            : new ControlPlaneDockerUncertainError("Docker command termination could not be established", { cause: error }))
        );
      };
      const append = (target: Buffer[], chunk: Buffer): void => {
        if (failure !== undefined) return;
        outputBytes += chunk.length;
        if (outputBytes > command.maximumOutputBytes) {
          stop("limit");
          return;
        }
        target.push(chunk);
      };
      const timeout = setTimeout(() => stop("timeout"), command.timeoutMilliseconds);
      const finish = (result: ControlPlaneDockerCommandResult | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };

      child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
      child.once("error", (error) => {
        if (failure === undefined) finish(new ControlPlaneDockerExecutionError("failed to execute Docker", { cause: error }));
      });
      child.once("close", (exitCode, signal) => {
        childClosed = true;
        if (failure === "limit") {
          return;
        }
        if (failure === "timeout") {
          return;
        }
        const signalExitCode = signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : 1;
        finish({
          exitCode: exitCode ?? signalExitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      });
    });
  }
}

async function terminateProcessTree(leaderPid: number | undefined, closed: () => boolean): Promise<void> {
  if (leaderPid === undefined) throw new ControlPlaneDockerUncertainError("Docker command has no process identity");
  const descendants = new Set(await descendantPids(leaderPid));
  signalTargets(leaderPid, descendants, "SIGTERM");
  if (await waitForExit(leaderPid, descendants, closed)) return;
  for (const pid of await descendantPids(leaderPid)) descendants.add(pid);
  for (const pid of [...descendants]) {
    for (const nested of await descendantPids(pid)) descendants.add(nested);
  }
  signalTargets(leaderPid, descendants, "SIGKILL");
  if (await waitForExit(leaderPid, descendants, closed)) return;
  throw new ControlPlaneDockerUncertainError("Docker command remained active after SIGKILL");
}

function signalTargets(leaderPid: number, descendants: ReadonlySet<number>, signal: NodeJS.Signals): void {
  sendSignal(-leaderPid, signal);
  for (const pid of descendants) sendSignal(pid, signal);
}

function sendSignal(pid: number, value: NodeJS.Signals): void {
  try {
    process.kill(pid, value);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function waitForExit(leaderPid: number, descendants: ReadonlySet<number>, closed: () => boolean): Promise<boolean> {
  const deadline = performance.now() + terminationGraceMilliseconds;
  while (performance.now() < deadline) {
    if (closed() && !processExists(-leaderPid) && [...descendants].every((pid) => !processExists(pid))) return true;
    await delay(10);
  }
  return closed() && !processExists(-leaderPid) && [...descendants].every((pid) => !processExists(pid));
}

async function descendantPids(pid: number): Promise<readonly number[]> {
  let value: string;
  try {
    value = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const direct = value.trim() === "" ? [] : value.trim().split(/\s+/).map(Number);
  const nested = await Promise.all(direct.map(descendantPids));
  return [...direct, ...nested.flat()];
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
