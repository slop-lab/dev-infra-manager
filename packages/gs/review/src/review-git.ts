import type {
  RepositoryAccess,
  RepositoryReadService,
} from "@slop-lab/gs-repository-service";
import type { ReviewChangedPath } from "@slop-lab/gs-review-contracts";
import { parseChangedPaths } from "./changed-paths.js";
import {
  assertDifferingReviewTrees,
  hasVerifiedReviewPathTrees,
  AuthoritativeReviewGitError,
  readVerifiedReviewObject,
} from "./review-object-integrity.js";

export { AuthoritativeReviewGitError } from "./review-object-integrity.js";

const maximumOutputBytes = 128 * 1024 * 1024;

export type AuthoritativeGitReviewEvidence = {
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly changes: readonly ReviewChangedPath[];
  readonly patch: string;
  readonly patchBytes: string;
};

export async function inspectAuthoritativeReviewGit(input: {
  readonly reader: RepositoryReadService;
  readonly access: RepositoryAccess;
  readonly protectedRef: string;
  readonly expectedProtectedHead: string;
  readonly proposalRef: string;
  readonly signal: AbortSignal;
}): Promise<AuthoritativeGitReviewEvidence> {
  const protectedHead = await resolveCommit(input.reader, input.access, input.protectedRef, input.signal);
  if (protectedHead !== input.expectedProtectedHead) throw new AuthoritativeReviewGitError("protected ref changed before review creation");
  const candidateCommit = await resolveCommit(input.reader, input.access, input.proposalRef, input.signal);
  const protectedTree = await input.reader.readCommitTree(input.access, protectedHead);
  const candidateTree = await input.reader.readCommitTree(input.access, candidateCommit);
  if (candidateCommit.length !== protectedHead.length || protectedTree.length !== protectedHead.length
    || candidateTree.length !== protectedHead.length) {
    throw new AuthoritativeReviewGitError("review object format conflicts");
  }
  await readVerifiedReviewObject({ ...input, objectId: candidateCommit, type: "commit", maximumBytes: maximumOutputBytes });
  const protectedTreeContent = await readVerifiedReviewObject({ ...input,
    objectId: protectedTree, type: "tree", maximumBytes: maximumOutputBytes });
  const candidateTreeContent = await readVerifiedReviewObject({ ...input,
    objectId: candidateTree, type: "tree", maximumBytes: maximumOutputBytes });
  await assertDifferingReviewTrees({
    left: { objectId: protectedTree, content: protectedTreeContent },
    right: { objectId: candidateTree, content: candidateTreeContent },
    maximumBytes: maximumOutputBytes,
    readTree: (objectId, maximumBytes) => readVerifiedReviewObject({
      ...input, objectId, type: "tree", maximumBytes,
    }),
  });
  const raw = await input.reader.readBytes({
    access: input.access,
    args: ["diff", "--raw", "-z", "--no-textconv", "--find-renames", "--find-copies", "--full-index", "--no-abbrev", protectedHead, candidateCommit],
    signal: input.signal,
    maximumBytes: maximumOutputBytes,
  });
  const readBlob = (objectId: string): Promise<Buffer> => readReviewBlob({
    reader: input.reader,
    access: input.access,
    objectId,
    signal: input.signal,
    maximumBytes: maximumOutputBytes,
  });
  const changes = await parseChangedPaths({ raw, readBlob });
  const changedBlobs = new Set<string>();
  for (const change of changes) {
    if (change.oldObjectId !== "0" && (change.oldMode === "100644" || change.oldMode === "100755")) {
      changedBlobs.add(change.oldObjectId);
    }
    if (change.newObjectId !== "0" && (change.newMode === "100644" || change.newMode === "100755")) {
      changedBlobs.add(change.newObjectId);
    }
  }
  let verifiedBlobBytes = 0;
  for (const objectId of changedBlobs) {
    if (verifiedBlobBytes >= maximumOutputBytes) {
      throw new AuthoritativeReviewGitError("review changed blobs exceed output limit");
    }
    const content = await readReviewBlob({
      reader: input.reader,
      access: input.access,
      objectId,
      signal: input.signal,
      maximumBytes: maximumOutputBytes - verifiedBlobBytes,
    });
    verifiedBlobBytes += content.length;
  }
  const patch = Buffer.from(await input.reader.readBytes({
    access: input.access,
    args: ["diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies", "--full-index", protectedHead, candidateCommit],
    signal: input.signal,
    maximumBytes: maximumOutputBytes,
  }));
  return {
    expectedProtectedHead: protectedHead,
    candidateCommit,
    candidateTree,
    changes,
    patch: patch.toString("utf8"),
    patchBytes: patch.toString("base64"),
  };
}

export async function assertAuthoritativeReviewRefs(input: {
  readonly reader: RepositoryReadService;
  readonly access: RepositoryAccess;
  readonly protectedRef: string;
  readonly proposalRef: string;
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const [protectedHead, candidateCommit] = await Promise.all([
    resolveCommit(input.reader, input.access, input.protectedRef, input.signal),
    resolveCommit(input.reader, input.access, input.proposalRef, input.signal),
  ]);
  const candidateTree = await input.reader.readCommitTree(input.access, candidateCommit);
  if (protectedHead !== input.expectedProtectedHead || candidateCommit !== input.candidateCommit
    || candidateTree !== input.candidateTree) throw new AuthoritativeReviewGitError("review refs changed");
}

export async function readAuthoritativeReviewRefs(input: {
  readonly reader: RepositoryReadService;
  readonly access: RepositoryAccess;
  readonly protectedRef: string;
  readonly proposalRef: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly protectedHead: string; readonly candidateCommit: string; readonly candidateTree: string }> {
  const [protectedHead, candidateCommit] = await Promise.all([
    resolveCommit(input.reader, input.access, input.protectedRef, input.signal),
    resolveCommit(input.reader, input.access, input.proposalRef, input.signal),
  ]);
  return { protectedHead, candidateCommit, candidateTree: await input.reader.readCommitTree(input.access, candidateCommit) };
}

export async function readAuthoritativeCandidateFile(input: {
  readonly reader: RepositoryReadService;
  readonly access: RepositoryAccess;
  readonly candidateCommit: string;
  readonly path: string;
  readonly signal: AbortSignal;
}): Promise<Buffer | undefined> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.candidateCommit)) {
    throw new AuthoritativeReviewGitError("invalid candidate commit identity");
  }
  if (Buffer.byteLength(input.path, "utf8") > 1024 || input.path.length === 0 || input.path.startsWith("/")
    || input.path.includes("\0") || input.path.includes("\\")
    || input.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new AuthoritativeReviewGitError("candidate file path must be a normalized relative path");
  }
  await readVerifiedReviewObject({ ...input, objectId: input.candidateCommit,
    type: "commit", maximumBytes: maximumOutputBytes });
  const candidateTree = await input.reader.readCommitTree(input.access, input.candidateCommit);
  const candidateTreeContent = await readVerifiedReviewObject({ ...input,
    objectId: candidateTree, type: "tree", maximumBytes: maximumOutputBytes });
  if (!(await hasVerifiedReviewPathTrees({
    root: { objectId: candidateTree, content: candidateTreeContent },
    path: Buffer.from(input.path, "utf8"),
    maximumBytes: maximumOutputBytes,
    readTree: (objectId, maximumBytes) => readVerifiedReviewObject({
      ...input, objectId, type: "tree", maximumBytes,
    }),
  }))) return undefined;
  const result = Buffer.from(await input.reader.readBytes({
    access: input.access,
    args: ["ls-tree", "-z", "--full-tree", input.candidateCommit, "--", `:(literal)${input.path}`],
    signal: input.signal,
  }));
  if (result.length === 0) return undefined;
  const entries = splitNul(result);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined) throw new AuthoritativeReviewGitError("candidate tree file identity is ambiguous");
  const separator = entry.indexOf(9);
  if (separator < 0 || !entry.subarray(separator + 1).equals(Buffer.from(input.path, "utf8"))) {
    throw new AuthoritativeReviewGitError("candidate tree file identity conflicts");
  }
  const metadata = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})$/
    .exec(entry.subarray(0, separator).toString("ascii"));
  if (metadata?.[2] === undefined) {
    throw new AuthoritativeReviewGitError("candidate matcher input must be a regular file");
  }
  return readReviewBlob({ ...input, objectId: metadata[2], maximumBytes: 1024 * 1024 });
}

export async function readReviewBlob(input: {
  readonly reader: RepositoryReadService;
  readonly access: RepositoryAccess;
  readonly objectId: string;
  readonly signal: AbortSignal;
  readonly maximumBytes?: number;
}): Promise<Buffer> {
  if (input.objectId === "0") return Buffer.alloc(0);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.objectId)) {
    throw new AuthoritativeReviewGitError("invalid review blob identity");
  }
  const maximumBytes = input.maximumBytes ?? 1024 * 1024;
  const size = Number(Buffer.from(await input.reader.readBytes({
    access: input.access,
    args: ["cat-file", "-s", input.objectId],
    signal: input.signal,
    maximumBytes: 1024,
  })).toString("utf8").trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
    throw new AuthoritativeReviewGitError("review blob exceeds byte limit");
  }
  return readVerifiedReviewObject({ ...input, type: "blob", maximumBytes });
}

async function resolveCommit(
  reader: RepositoryReadService,
  access: RepositoryAccess,
  ref: string,
  signal: AbortSignal,
): Promise<string> {
  return Buffer.from(await reader.readBytes({
    access,
    args: ["rev-parse", "--verify", `${ref}^{commit}`],
    signal,
    maximumBytes: 1024,
  })).toString("utf8").trim();
}

function splitNul(value: Buffer): readonly Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    fields.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start !== value.length) throw new AuthoritativeReviewGitError("Git tree output is not NUL terminated");
  return fields;
}
