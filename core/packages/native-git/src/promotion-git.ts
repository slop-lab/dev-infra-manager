import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { NativeGitServiceConfig } from "./config.js";

const execute = promisify(execFile);
const MAX_STDERR_BYTES = 64 * 1024;

type PromotionTarget = {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly protectedRef: string;
  readonly proposalRef: string;
};

export async function candidateDescendsFrom(
  config: Pick<NativeGitServiceConfig, "gitExecutable" | "storageRoot">,
  target: Pick<PromotionTarget, "projectId" | "repositoryId">,
  expectedHead: string,
  candidateCommit: string
): Promise<boolean> {
  const repositoryPath = join(config.storageRoot, target.projectId, `${target.repositoryId}.git`);
  try {
    await execute(config.gitExecutable, ["--git-dir", repositoryPath, "merge-base", "--is-ancestor", expectedHead, candidateCommit], {
      env: gitEnvironment()
    });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) return false;
    throw error;
  }
}

export async function atomicPromote(
  config: Pick<NativeGitServiceConfig, "gitExecutable" | "storageRoot">,
  target: PromotionTarget,
  expectedHead: string,
  candidateCommit: string
): Promise<boolean> {
  const repositoryPath = join(config.storageRoot, target.projectId, `${target.repositoryId}.git`);
  const commands = [
    "start",
    `update ${target.protectedRef} ${candidateCommit} ${expectedHead}`,
    `verify ${target.proposalRef} ${candidateCommit}`,
    "prepare",
    "commit",
    ""
  ].join("\n");
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(config.gitExecutable, ["--git-dir", repositoryPath, "update-ref", "--stdin"], {
      env: gitEnvironment(),
      stdio: ["pipe", "ignore", "pipe"]
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
    });
    child.stdin.once("error", reject);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null) {
        reject(new GitPromotionError(`Git promotion terminated by signal ${signal}`));
        return;
      }
      if (stderrBytes > MAX_STDERR_BYTES) {
        reject(new GitPromotionError("Git promotion stderr exceeded the output bound"));
        return;
      }
      if (code === 0) {
        resolve(true);
        return;
      }
      resolve(false);
    });
    child.stdin.end(commands);
  });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" };
}

class GitPromotionError extends Error {
  readonly name = "GitPromotionError";
}
