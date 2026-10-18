import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export const gitExecutable = "/usr/bin/git";

export async function git(
  cwd: string,
  args: readonly string[]
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return execute(gitExecutable, [...args], {
    cwd,
    env: { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10_000
  });
}
