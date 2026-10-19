import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const holder = "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.once('end',()=>process.exit(0));";
export type KernelGuard = { release(): Promise<void> };
/** Linux flock owns a permanent validated inode; parent death closes the holder's stdin. */
export async function tryAcquireKernelGuard(path: string, options: { readonly timeoutMilliseconds?: number } = {}): Promise<KernelGuard | undefined> {
  const timeout = options.timeoutMilliseconds ?? 0;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 30_000) throw new Error("flock timeout must be an integer from 0 to 30000 milliseconds");
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1) {
      throw new Error("control-plane guard must be a private user-owned regular file");
    }
    const child = spawn("flock", ["--exclusive", "--conflict-exit-code", "75", "--no-fork",
      ...(timeout === 0 ? ["--nonblock"] : ["--wait", String(timeout / 1000)]), "/proc/self/fd/3", process.execPath, "--eval", holder],
    { stdio: ["pipe", "pipe", "pipe", file.fd] });
    const { stdin, stdout: output, stderr: errors } = child;
    if (stdin === null || output === null || errors === null) { child.kill(); throw new Error("control-plane flock pipes are unavailable"); }
    output.setEncoding("utf8"); errors.setEncoding("utf8");
    let stdout = "", stderr = "";
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    return await new Promise<KernelGuard | undefined>((resolve, reject) => {
      child.once("error", reject);
      errors.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, 4096); });
      let release: Promise<void> | undefined;
      output.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(0, 4096);
        if (stdout !== "locked\n") return;
        resolve({ release: () => release ??= (async () => {
          stdin.end();
          const result = await exited;
          if (result.code !== 0) throw new Error(`control-plane flock holder exited with ${String(result.code ?? result.signal)}`);
        })() });
      });
      void exited.then((result) => {
        if (result.code === 75) resolve(undefined);
        else if (stdout !== "locked\n") reject(new Error(`control-plane flock failed with ${String(result.code ?? result.signal)}: ${stderr}`));
      });
    });
  } finally { await file.close(); }
}
