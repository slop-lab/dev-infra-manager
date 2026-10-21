import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertGitExecutableIdentity, type GitExecutableIdentity } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { CandidateExecutionError } from "@slop-lab/dim-contracts-ci/descriptor";

const execute = promisify(execFile);
const processTimeout = 10_000;
const metadataLimit = 4096;

export type CandidateGitReader = {
  readonly executable: string;
  readonly repositoryPath: string;
  readonly identity: GitExecutableIdentity;
};

export type GitBlob = {
  readonly objectId: string;
  readonly bytes: Buffer;
};

export type CandidateObjectTuple = {
  readonly protectedRef: string;
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
};

export async function assertCandidateObjects(
  reader: CandidateGitReader,
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
  reader: CandidateGitReader,
  tree: string,
  path: string,
  maximumBytes: number
): Promise<GitBlob> {
  const components = path.split("/");
  let objectId = tree;
  for (const [index, component] of components.entries()) {
    const entry = await readLiteralTreeEntry(reader, objectId, component, path);
    if (entry === undefined) {
      throw new CandidateExecutionError(`candidate tree does not contain one literal entry at ${path}`);
    }
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

export async function candidatePathExists(
  reader: CandidateGitReader,
  tree: string,
  path: string
): Promise<boolean> {
  const components = path.split("/");
  let objectId = tree;
  for (const [index, component] of components.entries()) {
    const entry = await readLiteralTreeEntry(reader, objectId, component, path);
    if (entry === undefined) return false;
    if (index < components.length - 1) {
      if (entry.mode !== "040000" || entry.type !== "tree") return true;
      objectId = entry.objectId;
    }
  }
  return true;
}

async function readLiteralTreeEntry(
  reader: CandidateGitReader,
  tree: string,
  component: string,
  fullPath: string
): Promise<{ readonly mode: string; readonly type: string; readonly objectId: string } | undefined> {
  const listing = await gitBuffer(reader, ["ls-tree", "-z", tree, "--", `:(literal)${component}`], metadataLimit);
  if (listing.length === 0) return undefined;
  if (listing[listing.length - 1] !== 0 || listing.subarray(0, listing.length - 1).includes(0)) {
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

async function gitText(reader: CandidateGitReader, args: readonly string[]): Promise<string> {
  return (await gitBuffer(reader, args, metadataLimit)).toString("ascii").trim();
}

async function gitBuffer(reader: CandidateGitReader, args: readonly string[], maxBuffer: number): Promise<Buffer> {
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
