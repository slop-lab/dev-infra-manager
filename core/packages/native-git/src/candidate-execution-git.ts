import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { NativeGitServiceConfig } from "./config.js";
import { assertGitExecutableIdentity, assertGitVersion, type GitExecutableIdentity } from "./repository.js";
import { CandidateExecutionError } from "./candidate-execution-schema.js";

const execute = promisify(execFile);
const processTimeout = 10_000;
const metadataLimit = 4096;

type GitReader = {
  readonly executable: string;
  readonly repositoryPath: string;
  readonly identity: GitExecutableIdentity;
};

export type GitBlob = {
  readonly objectId: string;
  readonly bytes: Buffer;
};

type CandidateObjectTuple = {
  readonly protectedRef: string;
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
};

export async function openCandidateGitReader(
  config: Pick<NativeGitServiceConfig, "gitExecutable" | "gitVersion" | "storageRoot">,
  projectId: string,
  repositoryId: string
): Promise<GitReader> {
  return {
    executable: config.gitExecutable,
    repositoryPath: join(config.storageRoot, projectId, `${repositoryId}.git`),
    identity: await assertGitVersion(config)
  };
}

export async function assertCandidateObjects(
  reader: GitReader,
  target: CandidateObjectTuple
): Promise<void> {
  const protectedHead = await gitText(reader, ["rev-parse", "--verify", `${target.protectedRef}^{commit}`]);
  if (protectedHead !== target.expectedProtectedHead) throw new CandidateExecutionError("expected protected head is stale");
  const resolvedCommit = await gitText(reader, ["rev-parse", "--verify", `${target.candidateCommit}^{commit}`]);
  if (resolvedCommit !== target.candidateCommit) throw new CandidateExecutionError("candidate commit identity does not match");
  const resolvedTree = await gitText(reader, ["rev-parse", "--verify", `${target.candidateCommit}^{tree}`]);
  if (resolvedTree !== target.candidateTree) throw new CandidateExecutionError("candidate tree identity does not match its commit");
}

export async function readCandidateBlob(
  reader: GitReader,
  tree: string,
  path: string,
  maximumBytes: number
): Promise<GitBlob> {
  const components = path.split("/");
  let objectId = tree;
  for (const [index, component] of components.entries()) {
    const entry = await readLiteralTreeEntry(reader, objectId, component, path);
    if (index < components.length - 1) {
      if (entry.mode !== "040000" || entry.type !== "tree") {
        throw new CandidateExecutionError(`candidate path has a non-tree ancestor at ${path}`);
      }
    } else if ((entry.mode !== "100644" && entry.mode !== "100755") || entry.type !== "blob") {
      throw new CandidateExecutionError(`candidate tree does not contain one regular blob at ${path}`);
    }
    objectId = entry.objectId;
  }
  const sizeText = await gitText(reader, ["cat-file", "-s", objectId]);
  if (!/^(?:0|[1-9][0-9]*)$/.test(sizeText) || BigInt(sizeText) > BigInt(maximumBytes)) {
    throw new CandidateExecutionError(`candidate blob exceeds its byte limit at ${path}`);
  }
  const bytes = await gitBuffer(reader, ["cat-file", "blob", objectId], maximumBytes);
  if (BigInt(bytes.length) !== BigInt(sizeText)) throw new CandidateExecutionError(`candidate blob size changed at ${path}`);
  return { objectId, bytes };
}

async function readLiteralTreeEntry(
  reader: GitReader,
  tree: string,
  component: string,
  fullPath: string
): Promise<{ readonly mode: string; readonly type: string; readonly objectId: string }> {
  const listing = await gitBuffer(reader, ["ls-tree", "-z", tree, "--", `:(literal)${component}`], metadataLimit);
  if (listing.length === 0 || listing[listing.length - 1] !== 0 || listing.subarray(0, listing.length - 1).includes(0)) {
    throw new CandidateExecutionError(`candidate tree does not contain one literal entry at ${fullPath}`);
  }
  const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^/]+)$/.exec(
    listing.subarray(0, listing.length - 1).toString("utf8")
  );
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined || match[4] !== component) {
    throw new CandidateExecutionError(`candidate tree does not contain one literal entry at ${fullPath}`);
  }
  return { mode: match[1], type: match[2], objectId: match[3] };
}

async function gitText(reader: GitReader, args: readonly string[]): Promise<string> {
  return (await gitBuffer(reader, args, metadataLimit)).toString("ascii").trim();
}

async function gitBuffer(reader: GitReader, args: readonly string[], maxBuffer: number): Promise<Buffer> {
  await assertGitExecutableIdentity(reader.executable, reader.identity);
  try {
    const result = await execute(reader.executable, ["--git-dir", reader.repositoryPath, ...args], {
      encoding: "buffer",
      env: { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" },
      maxBuffer,
      timeout: processTimeout
    });
    if (!Buffer.isBuffer(result.stdout)) throw new CandidateExecutionError("Git returned non-buffer output");
    return result.stdout;
  } catch (error) {
    if (error instanceof CandidateExecutionError) throw error;
    throw new CandidateExecutionError("Git could not read the candidate object", { cause: error });
  }
}
