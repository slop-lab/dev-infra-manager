import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AuthoritativeNativeChangedPath } from "./authoritative-native-review-schema.js";
import { assertGitExecutableIdentity, type GitExecutableIdentity } from "./repository.js";

const execute = promisify(execFile);
const maximumOutputBytes = 128 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const gitEnvironment = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  HOME: "/dev/null",
  LC_ALL: "C"
} as const;

type PinnedReviewGit = {
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly repository: string;
  readonly signal: AbortSignal;
};

export type AuthoritativeNativeGitReviewEvidence = {
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly changes: readonly AuthoritativeNativeChangedPath[];
  readonly patch: string;
  readonly patchBytes: string;
};

export async function inspectAuthoritativeNativeReviewGit(
  input: PinnedReviewGit & {
    readonly protectedRef: string;
    readonly expectedProtectedHead: string;
    readonly proposalRef: string;
  }
): Promise<AuthoritativeNativeGitReviewEvidence> {
  const protectedHead = await resolveCommit(input, input.protectedRef);
  if (protectedHead !== input.expectedProtectedHead) {
    throw new AuthoritativeNativeReviewGitError("authoritative native protected ref changed before review creation");
  }
  const candidateCommit = await resolveCommit(input, input.proposalRef);
  const candidateTree = await resolveObject(input, `${candidateCommit}^{tree}`);
  if (candidateCommit.length !== protectedHead.length || candidateTree.length !== protectedHead.length) {
    throw new AuthoritativeNativeReviewGitError("authoritative native review object format conflicts");
  }
  await runPinned(input, ["-c", "fsck.fullPathname=error", "fsck", "--strict", "--full",
    "--no-reflogs", "--no-progress", candidateCommit]);
  const raw = await runPinnedBuffer(input, [
    "diff", "--raw", "-z", "--no-textconv", "--find-renames", "--find-copies", "--full-index", "--no-abbrev",
    protectedHead, candidateCommit
  ]);
  const changes = await parseChanges(input, raw);
  const patch = await runPinnedBuffer(input, [
    "diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies",
    "--full-index", protectedHead, candidateCommit
  ]);
  return {
    expectedProtectedHead: protectedHead,
    candidateCommit,
    candidateTree,
    changes,
    patch: patch.toString("utf8"),
    patchBytes: patch.toString("base64")
  };
}

export async function assertAuthoritativeNativeReviewRefs(
  input: PinnedReviewGit & {
    readonly protectedRef: string;
    readonly proposalRef: string;
    readonly expectedProtectedHead: string;
    readonly candidateCommit: string;
    readonly candidateTree: string;
  }
): Promise<void> {
  const [protectedHead, candidateCommit] = await Promise.all([
    resolveCommit(input, input.protectedRef),
    resolveCommit(input, input.proposalRef)
  ]);
  const candidateTree = await resolveObject(input, `${candidateCommit}^{tree}`);
  if (protectedHead !== input.expectedProtectedHead || candidateCommit !== input.candidateCommit
    || candidateTree !== input.candidateTree) {
    throw new AuthoritativeNativeReviewGitError("authoritative native refs changed during review creation");
  }
}

export async function readAuthoritativeNativeReviewRefs(
  input: PinnedReviewGit & { readonly protectedRef: string; readonly proposalRef: string }
): Promise<{
  readonly protectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
}> {
  const [protectedHead, candidateCommit] = await Promise.all([
    resolveCommit(input, input.protectedRef),
    resolveCommit(input, input.proposalRef)
  ]);
  return {
    protectedHead,
    candidateCommit,
    candidateTree: await resolveObject(input, `${candidateCommit}^{tree}`)
  };
}

async function parseChanges(input: PinnedReviewGit, output: Buffer): Promise<readonly AuthoritativeNativeChangedPath[]> {
  const fields = splitNul(output);
  const changes: AuthoritativeNativeChangedPath[] = [];
  for (let index = 0; index < fields.length;) {
    const metadata = fields[index];
    const firstPath = fields[index + 1];
    if (metadata === undefined || firstPath === undefined) throw new AuthoritativeNativeReviewGitError("Git raw diff is incomplete");
    const parsed = parseMetadata(metadata.toString("ascii"));
    const pair = parsed.status === "renamed" || parsed.status === "copied";
    const secondPath = pair ? fields[index + 2] : undefined;
    if (pair && secondPath === undefined) throw new AuthoritativeNativeReviewGitError("Git rename diff is incomplete");
    const oldPath = parsed.status === "added" ? Buffer.alloc(0) : firstPath;
    const newPath = parsed.status === "deleted" ? Buffer.alloc(0) : (secondPath ?? firstPath);
    const oldTarget = parsed.oldMode === "120000" ? await readBlob(input, parsed.oldObjectId) : undefined;
    const newTarget = parsed.newMode === "120000" ? await readBlob(input, parsed.newObjectId) : undefined;
    changes.push({
      ...parsed,
      ...(oldPath.length === 0 ? {} : { oldPath: displayBytes(oldPath) }),
      ...(newPath.length === 0 ? {} : { newPath: displayBytes(newPath) }),
      oldPathBytes: oldPath.toString("base64"),
      newPathBytes: newPath.toString("base64"),
      ...(oldTarget === undefined ? {} : {
        oldSymlinkTarget: displayBytes(oldTarget), oldSymlinkTargetBytes: oldTarget.toString("base64")
      }),
      ...(newTarget === undefined ? {} : {
        newSymlinkTarget: displayBytes(newTarget), newSymlinkTargetBytes: newTarget.toString("base64")
      })
    });
    index += pair ? 3 : 2;
  }
  return changes;
}

function parseMetadata(value: string): Omit<AuthoritativeNativeChangedPath,
  "oldPath" | "newPath" | "oldPathBytes" | "newPathBytes" | "oldSymlinkTarget"
  | "newSymlinkTarget" | "oldSymlinkTargetBytes" | "newSymlinkTargetBytes"> {
  const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMTRC])([0-9]{1,3})?$/.exec(value);
  if (match === null) throw new AuthoritativeNativeReviewGitError("Git raw diff metadata is unsupported");
  const oldMode = match[1];
  const newMode = match[2];
  const oldObject = match[3];
  const newObject = match[4];
  const code = match[5];
  if (oldMode === undefined || newMode === undefined || oldObject === undefined
    || newObject === undefined || code === undefined) throw new AuthoritativeNativeReviewGitError("Git raw diff metadata is incomplete");
  const status = code === "A" ? "added" : code === "D" ? "deleted" : code === "M" ? "modified"
    : code === "R" ? "renamed" : code === "C" ? "copied" : "type-changed";
  const score = match[6];
  return {
    status,
    oldMode,
    newMode,
    oldObjectId: /^0+$/.test(oldObject) ? "0" : oldObject,
    newObjectId: /^0+$/.test(newObject) ? "0" : newObject,
    ...(score === undefined ? {} : { similarity: Number.parseInt(score, 10) })
  };
}

function splitNul(value: Buffer): readonly Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    fields.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start !== value.length) throw new AuthoritativeNativeReviewGitError("Git raw diff is not NUL terminated");
  return fields;
}

function displayBytes(value: Buffer): string {
  try {
    return decoder.decode(value);
  } catch (error) {
    if (error instanceof TypeError) return `<base64:${value.toString("base64")}>`;
    throw error;
  }
}

async function readBlob(input: PinnedReviewGit, objectId: string): Promise<Buffer> {
  return objectId === "0" ? Buffer.alloc(0) : runPinnedBuffer(input, ["cat-file", "blob", objectId]);
}

async function resolveCommit(input: PinnedReviewGit, ref: string): Promise<string> {
  return resolveObject(input, `${ref}^{commit}`);
}

async function resolveObject(input: PinnedReviewGit, expression: string): Promise<string> {
  return (await runPinned(input, ["rev-parse", "--verify", expression])).stdout.trim();
}

async function runPinned(input: PinnedReviewGit, arguments_: readonly string[]) {
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  const result = await execute(input.gitExecutable,
    ["--no-replace-objects", "--git-dir", input.repository, ...arguments_], {
      env: gitEnvironment, maxBuffer: maximumOutputBytes, timeout: 30_000, signal: input.signal
    });
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  return result;
}

async function runPinnedBuffer(input: PinnedReviewGit, arguments_: readonly string[]): Promise<Buffer> {
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  const result = await execute(input.gitExecutable,
    ["--no-replace-objects", "--git-dir", input.repository, ...arguments_], {
      encoding: "buffer", env: gitEnvironment, maxBuffer: maximumOutputBytes, timeout: 30_000, signal: input.signal
    });
  await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
  if (!Buffer.isBuffer(result.stdout)) throw new AuthoritativeNativeReviewGitError("Git returned non-buffer output");
  return result.stdout;
}

export class AuthoritativeNativeReviewGitError extends Error {
  readonly name = "AuthoritativeNativeReviewGitError";
}
