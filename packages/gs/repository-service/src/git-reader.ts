import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertGitExecutableIdentity,
  type GitExecutableIdentity,
  type GitRepositoryRuntime,
} from "@slop-lab/gs-repository";
import { isOrdinaryCandidateRef, repositoryBranches } from "@slop-lab/gs-repository-contracts";
import type {
  RepositoryAccess,
  RepositoryBlobMetadata,
  RepositoryReadService,
} from "./ports.js";

const execute = promisify(execFile);
const defaultMaximumBytes = 4 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const gitEnvironment = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  HOME: "/dev/null",
  LC_ALL: "C",
} as const;

export function createGitRepositoryReadService(input: {
  readonly runtime: Pick<GitRepositoryRuntime, "gitExecutable">;
  readonly gitIdentity: GitExecutableIdentity;
}): RepositoryReadService {
  const readBytes: RepositoryReadService["readBytes"] = async (request) => {
    await assertGitExecutableIdentity(input.runtime.gitExecutable, input.gitIdentity);
    const execution = execute(input.runtime.gitExecutable, [
      "--no-replace-objects",
      "--git-dir",
      request.access.target.repositoryPath,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "diff.external=",
      ...request.args,
    ], {
      encoding: "buffer",
      env: gitEnvironment,
      maxBuffer: request.maximumBytes ?? defaultMaximumBytes,
      signal: request.signal,
      timeout: 30_000,
    });
    if (request.standardInput !== undefined) {
      execution.child.stdin?.on("error", () => execution.child.kill());
      execution.child.stdin?.end(Buffer.from(request.standardInput));
    }
    const { stdout } = await execution;
    await assertGitExecutableIdentity(input.runtime.gitExecutable, input.gitIdentity);
    if (!Buffer.isBuffer(stdout)) throw new RepositoryReadServiceError("Git returned non-buffer output");
    return stdout;
  };

  return {
    readBytes,
    async assertAdvertisedCommits(request) {
      await assertAdvertisedCommits(readBytes, request);
    },
    async readTreeFile(request) {
      return readTreeFile(readBytes, request);
    },
    async readRef(access, ref) {
      return utf8(await readBytes({
        access,
        args: ["rev-parse", "--verify", `${ref}^{commit}`],
        signal: AbortSignal.timeout(30_000),
        maximumBytes: 1024,
      })).trim();
    },
    async readCommitTree(access, commit) {
      assertCommit(commit);
      return utf8(await readBytes({
        access,
        args: ["rev-parse", "--verify", `${commit}^{tree}`],
        signal: AbortSignal.timeout(30_000),
        maximumBytes: 1024,
      })).trim();
    },
  };
}

async function assertAdvertisedCommits(
  readBytes: RepositoryReadService["readBytes"],
  request: Parameters<RepositoryReadService["assertAdvertisedCommits"]>[0],
): Promise<void> {
  request.commits.forEach(assertCommit);
  const protectedRefs = Object.keys(repositoryBranches(request.access.target.policy));
  const objects = new Set<string>();
  const refOutput = utf8(await readBytes({
    access: request.access,
    args: ["for-each-ref", "--format=%(refname)%09%(objectname)"],
    signal: request.signal,
  }));
  for (const entry of refOutput.trim().split("\n").filter(Boolean)) {
    const match = /^(refs\/[^\t]+)\t([0-9a-f]{40}|[0-9a-f]{64})$/.exec(entry);
    const ref = match?.[1];
    const objectId = match?.[2];
    if (ref === undefined || objectId === undefined) throw new RepositoryReadServiceError("repository ref identity is invalid");
    if (!protectedRefs.includes(ref) && !(request.advertisedRefs ?? []).includes(ref)
      && !isOrdinaryCandidateRef(ref) && !/^refs\/heads\/proposals\/[A-Za-z0-9_-]+\/.+/.test(ref)) continue;
    objects.add(objectId);
  }
  if (objects.size === 0) throw new RepositoryReadServiceError("repository has no advertised commits");
  const records = utf8(await readBytes({
    access: request.access,
    args: ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    signal: request.signal,
    standardInput: Buffer.from([...objects].map((objectId) => `${objectId}^{}\n`).join("")),
  })).trim().split("\n");
  const refs = new Set<string>();
  for (const record of records) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (commit|blob|tree)$/.exec(record);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new RepositoryReadServiceError("repository ref object is invalid");
    }
    if (match[2] === "commit") refs.add(match[1]);
  }
  for (const commit of request.commits) {
    let reachable = false;
    for (const ref of refs) {
      try {
        await readBytes({ access: request.access, args: ["merge-base", "--is-ancestor", commit, ref], signal: request.signal });
        reachable = true;
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === 1)) throw error;
      }
    }
    if (!reachable) throw new RepositoryReadServiceError("commit is outside advertised repository history");
  }
}

async function readTreeFile(
  readBytes: RepositoryReadService["readBytes"],
  request: Parameters<RepositoryReadService["readTreeFile"]>[0],
): Promise<RepositoryBlobMetadata | null> {
  assertCommit(request.commit);
  if (request.path.includes("\0") || request.path.length === 0) throw new RepositoryReadServiceError("invalid file path");
  const result = Buffer.from(await readBytes({
    access: request.access,
    args: ["ls-tree", "-z", "--full-tree", request.commit, "--", `:(literal)${request.path}`],
    signal: request.signal,
  }));
  if (result.length === 0) return null;
  const tab = result.indexOf(9);
  const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(result.subarray(0, tab).toString("ascii"));
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined
    || !result.subarray(tab + 1, -1).equals(Buffer.from(request.path))) {
    throw new RepositoryReadServiceError("tree file is ambiguous");
  }
  if (match[2] === "commit") return { blobId: match[3], mode: match[1], byteLength: 0, lineCount: null };
  const content = Buffer.from(await readBytes({
    access: request.access,
    args: ["cat-file", "blob", match[3]],
    signal: request.signal,
  }));
  let lineCount: number | null = null;
  if (!content.includes(0)) {
    try {
      utf8(content);
      lineCount = content.length === 0 ? 0
        : content.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0) + (content.at(-1) === 10 ? 0 : 1);
    } catch (error) {
      if (!(error instanceof RepositoryReadServiceError)) throw error;
    }
  }
  return { blobId: match[3], mode: match[1], byteLength: content.length, lineCount };
}

function assertCommit(commit: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new RepositoryReadServiceError("repository reads require complete immutable commit IDs");
  }
}

function utf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new RepositoryReadServiceError("repository data contains non-UTF-8 text");
    throw error;
  }
}

export class RepositoryReadServiceError extends Error {
  readonly name = "RepositoryReadServiceError";
}
