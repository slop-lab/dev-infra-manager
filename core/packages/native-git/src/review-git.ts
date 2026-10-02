import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { NativeGitServiceConfig } from "./config.js";
import type { ChangedPath } from "./review-schema.js";

const execute = promisify(execFile);
const MAX_DIFF_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type GitReviewEvidence = {
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly changes: readonly ChangedPath[];
  readonly patch: string;
  readonly patchBytes: string;
};

type GitReviewTarget = {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly protectedRef: string;
  readonly proposalRef: string;
};

export async function inspectGitReview(
  config: Pick<NativeGitServiceConfig, "gitExecutable" | "storageRoot">,
  target: GitReviewTarget
): Promise<GitReviewEvidence> {
  const repositoryPath = join(config.storageRoot, target.projectId, `${target.repositoryId}.git`);
  const expectedProtectedHead = await resolveCommit(config.gitExecutable, repositoryPath, target.protectedRef);
  const candidateCommit = await resolveCommit(config.gitExecutable, repositoryPath, target.proposalRef);
  const candidateTree = await resolveObject(config.gitExecutable, repositoryPath, `${candidateCommit}^{tree}`);
  const raw = await gitBuffer(config.gitExecutable, repositoryPath, [
    "diff", "--raw", "-z", "--find-renames", "--full-index", "--no-abbrev", expectedProtectedHead, candidateCommit
  ]);
  const changes = await parseChanges(config.gitExecutable, repositoryPath, raw);
  const patchBuffer = await gitBuffer(config.gitExecutable, repositoryPath, [
    "diff", "--binary", "--no-color", "--no-ext-diff", "--find-renames", "--full-index", expectedProtectedHead, candidateCommit
  ]);
  return {
    expectedProtectedHead,
    candidateCommit,
    candidateTree,
    changes,
    patch: patchBuffer.toString("utf8"),
    patchBytes: patchBuffer.toString("base64")
  };
}

export async function liveReviewObjects(
  config: Pick<NativeGitServiceConfig, "gitExecutable" | "storageRoot">,
  target: GitReviewTarget
): Promise<{ readonly protectedHead?: string; readonly candidateCommit?: string; readonly candidateTree?: string }> {
  const repositoryPath = join(config.storageRoot, target.projectId, `${target.repositoryId}.git`);
  const protectedHead = await optionalCommit(config.gitExecutable, repositoryPath, target.protectedRef);
  const candidateCommit = await optionalCommit(config.gitExecutable, repositoryPath, target.proposalRef);
  const candidateTree = candidateCommit === undefined
    ? undefined
    : await resolveObject(config.gitExecutable, repositoryPath, `${candidateCommit}^{tree}`);
  return {
    ...(protectedHead === undefined ? {} : { protectedHead }),
    ...(candidateCommit === undefined ? {} : { candidateCommit }),
    ...(candidateTree === undefined ? {} : { candidateTree })
  };
}

async function parseChanges(gitExecutable: string, repositoryPath: string, output: Buffer): Promise<readonly ChangedPath[]> {
  const fields = splitNul(output);
  const changes: ChangedPath[] = [];
  for (let index = 0; index < fields.length;) {
    const metadata = fields[index];
    const firstPath = fields[index + 1];
    if (metadata === undefined || firstPath === undefined) throw new GitReviewError("Git returned an incomplete raw diff");
    const parsed = parseMetadata(metadata.toString("ascii"));
    const renamed = parsed.status === "renamed" || parsed.status === "copied";
    const secondPath = renamed ? fields[index + 2] : undefined;
    if (renamed && secondPath === undefined) throw new GitReviewError("Git returned an incomplete rename diff");
    const oldPath = parsed.status === "added" ? Buffer.alloc(0) : firstPath;
    const newPath = parsed.status === "deleted" ? Buffer.alloc(0) : (secondPath ?? firstPath);
    changes.push({
      ...parsed,
      ...(oldPath.length === 0 ? {} : { oldPath: displayPath(oldPath) }),
      ...(newPath.length === 0 ? {} : { newPath: displayPath(newPath) }),
      oldPathBytes: oldPath.toString("base64"),
      newPathBytes: newPath.toString("base64"),
      ...(parsed.oldMode === "120000" ? { oldSymlinkTarget: await blobText(gitExecutable, repositoryPath, parsed.oldObjectId) } : {}),
      ...(parsed.newMode === "120000" ? { newSymlinkTarget: await blobText(gitExecutable, repositoryPath, parsed.newObjectId) } : {})
    });
    index += renamed ? 3 : 2;
  }
  return changes;
}

function parseMetadata(value: string): Omit<ChangedPath, "oldPath" | "newPath" | "oldPathBytes" | "newPathBytes" | "oldSymlinkTarget" | "newSymlinkTarget"> {
  const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMTRC])([0-9]{1,3})?$/.exec(value);
  if (match === null) throw new GitReviewError(`unsupported Git raw diff metadata: ${value}`);
  const oldMode = match[1];
  const newMode = match[2];
  const oldObject = match[3];
  const newObject = match[4];
  const code = match[5];
  if (oldMode === undefined || newMode === undefined || oldObject === undefined || newObject === undefined || code === undefined) {
    throw new GitReviewError("Git returned incomplete raw diff metadata");
  }
  const status = code === "A" ? "added"
    : code === "D" ? "deleted"
      : code === "M" ? "modified"
        : code === "R" ? "renamed"
          : code === "C" ? "copied"
            : "type-changed";
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
  if (start !== value.length) throw new GitReviewError("Git raw diff was not NUL terminated");
  return fields;
}

function displayPath(value: Buffer): string {
  try {
    return decoder.decode(value);
  } catch (error) {
    if (error instanceof TypeError) return `<base64:${value.toString("base64")}>`;
    throw error;
  }
}

async function blobText(gitExecutable: string, repositoryPath: string, objectId: string): Promise<string> {
  if (objectId === "0") return "";
  return (await gitBuffer(gitExecutable, repositoryPath, ["cat-file", "blob", objectId])).toString("utf8");
}

async function resolveCommit(gitExecutable: string, repositoryPath: string, ref: string): Promise<string> {
  return resolveObject(gitExecutable, repositoryPath, `${ref}^{commit}`);
}

async function optionalCommit(gitExecutable: string, repositoryPath: string, ref: string): Promise<string | undefined> {
  try {
    return await resolveCommit(gitExecutable, repositoryPath, ref);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 128) return undefined;
    throw error;
  }
}

async function resolveObject(gitExecutable: string, repositoryPath: string, expression: string): Promise<string> {
  const { stdout } = await execute(gitExecutable, ["--git-dir", repositoryPath, "rev-parse", "--verify", expression], {
    env: { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" }, maxBuffer: MAX_DIFF_BYTES
  });
  return stdout.trim();
}

async function gitBuffer(gitExecutable: string, repositoryPath: string, args: readonly string[]): Promise<Buffer> {
  const result = await execute(gitExecutable, ["--git-dir", repositoryPath, ...args], {
    encoding: "buffer", env: { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" }, maxBuffer: MAX_DIFF_BYTES
  });
  if (!Buffer.isBuffer(result.stdout)) throw new GitReviewError("Git returned non-buffer output");
  return result.stdout;
}

export class GitReviewError extends Error {
  readonly name = "GitReviewError";
}
