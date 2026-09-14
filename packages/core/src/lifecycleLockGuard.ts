import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { UserError } from "./errors.js";

const LOCK_HOLDER_SOURCE = "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.once('end',()=>process.exit(0));";

export type KernelGuard = { readonly release: () => Promise<void> };

export async function tryAcquireKernelGuard(guardPath: string): Promise<KernelGuard | undefined> {
  const guardFile = await open(guardPath, "a", 0o600);
  await guardFile.close();
  const child = spawn("flock", ["--exclusive", "--nonblock", guardPath, process.execPath, "--eval", LOCK_HOLDER_SOURCE], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return new Promise<KernelGuard | undefined>((resolve, reject) => {
    child.once("error", (error) => reject(new UserError(`cannot start Linux flock lifecycle guard: ${error.message}`)));
    child.stdout.on("data", () => {
      if (!stdout.includes("locked\n")) return;
      resolve({
        release: async () => {
          child.stdin.end();
          const result = await exited;
          if (result.code !== 0) {
            throw new UserError(`Linux flock lifecycle guard exited with ${String(result.code ?? result.signal)}`);
          }
        }
      });
    });
    void exited.then((result) => {
      if (result.code === 1) resolve(undefined);
      else if (!stdout.includes("locked\n")) {
        reject(new UserError(`Linux flock lifecycle guard failed with ${String(result.code ?? result.signal)}: ${stderr.trim()}`));
      }
    });
  });
}
