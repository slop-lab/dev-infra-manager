import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitRepositoryRuntime } from "./repository.js";
import { assertRepositorySelector, GitRepositoryError } from "./repository.js";

const execute = promisify(execFile);
const MAX_STDERR_BYTES = 64 * 1024;

type PromotionTarget = {
  readonly namespaceId: string;
  readonly repositoryId: string;
  readonly protectedRef: string;
  readonly proposalRef: string;
};

export async function candidateDescendsFrom(
  config: Pick<GitRepositoryRuntime, "gitExecutable" | "storageRoot">,
  target: Pick<PromotionTarget, "namespaceId" | "repositoryId">,
  expectedHead: string,
  candidateCommit: string
): Promise<boolean> {
  assertRepositorySelector(target);
  assertObjectIds(expectedHead, candidateCommit);
  const repositoryPath = join(config.storageRoot, target.namespaceId, `${target.repositoryId}.git`);
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
  config: Pick<GitRepositoryRuntime, "gitExecutable" | "storageRoot">,
  target: PromotionTarget,
  expectedHead: string,
  candidateCommit: string
): Promise<boolean> {
  assertRepositorySelector(target);
  assertObjectIds(expectedHead, candidateCommit);
  if (!target.protectedRef.startsWith("refs/heads/") || /[\s\0]/.test(target.protectedRef)) throw new GitRepositoryError("invalid protected branch ref");
  const repositoryPath = join(config.storageRoot, target.namespaceId, `${target.repositoryId}.git`);
  const candidateRef = await candidateRefState(config.gitExecutable, repositoryPath, target.proposalRef, candidateCommit);
  if (candidateRef === undefined) return false;
  const commands = [
    "start",
    `update ${target.protectedRef} ${candidateCommit} ${expectedHead}`,
    `verify ${target.proposalRef} ${candidateRef}`,
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

async function candidateRefState(
  gitExecutable: string,
  repositoryPath: string,
  candidateRef: string,
  candidateCommit: string
): Promise<string | undefined> {
  try {
    const raw = (await execute(gitExecutable, ["--git-dir", repositoryPath, "rev-parse", "--verify", candidateRef], {
      env: gitEnvironment()
    })).stdout.trim();
    const peeled = (await execute(gitExecutable, ["--git-dir", repositoryPath, "rev-parse", "--verify", `${raw}^{commit}`], {
      env: gitEnvironment()
    })).stdout.trim();
    return peeled === candidateCommit ? raw : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === 1 || error.code === 128)) return undefined;
    throw error;
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", HOME: "/dev/null", LC_ALL: "C" };
}

class GitPromotionError extends Error {
  readonly name = "GitPromotionError";
}
function assertObjectIds(...values: readonly string[]): void {
  if (values.some((value) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))) throw new GitRepositoryError("expected complete Git object identities");
}
