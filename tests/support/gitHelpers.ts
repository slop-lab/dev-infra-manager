import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const gitExecutable = "/usr/bin/git";

export async function refValue(repository: string, ref: string): Promise<string | undefined> {
  try {
    return (await run(gitExecutable, ["--git-dir", repository, "rev-parse", "--verify", ref], {
      env: { ...process.env, LC_ALL: "C" }
    })).stdout.trim();
  } catch (error) {
    if (isExitError(error)) return undefined;
    throw error;
  }
}

export function isExitError(error: unknown): error is Error & { readonly stderr: string } {
  return error instanceof Error && "stderr" in error && typeof error.stderr === "string";
}

