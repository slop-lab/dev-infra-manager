import { createHash } from "node:crypto";
import type { DisposableGit, GitObjectFormat } from "./nativeGitCandidateProcess.js";

const objectFormatProperties = {
  sha1: { rawLength: 20, hashAlgorithm: "sha1" },
  sha256: { rawLength: 32, hashAlgorithm: "sha256" }
} as const satisfies Record<GitObjectFormat, {
  readonly rawLength: number;
  readonly hashAlgorithm: "sha1" | "sha256";
}>;

export type NativeGitObjectRead = {
  readonly git: DisposableGit;
  readonly objectId: string;
  readonly maximumBytes: number;
  readonly signal: AbortSignal;
};

export function rawObjectIdLength(format: GitObjectFormat): number {
  return objectFormatProperties[format].rawLength;
}

export async function readVerifiedTreeBytes(input: NativeGitObjectRead): Promise<Buffer> {
  const bytes = await input.git.run([
    "--git-dir", input.git.repository, "cat-file", "tree", input.objectId
  ], input.maximumBytes, input.signal);
  assertObjectId(input.git.objectFormat, "tree", bytes, input.objectId);
  return bytes;
}

export async function readVerifiedBlobObject(input: NativeGitObjectRead): Promise<Buffer> {
  const sizeText = (await input.git.run([
    "--git-dir", input.git.repository, "cat-file", "-s", input.objectId
  ], 64, input.signal)).toString("ascii").trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(sizeText) || BigInt(sizeText) > BigInt(input.maximumBytes)) {
    throw new NativeGitObjectBytesError("native Git blob exceeds its byte limit");
  }
  const bytes = await input.git.run([
    "--git-dir", input.git.repository, "cat-file", "blob", input.objectId
  ], input.maximumBytes, input.signal);
  if (bytes.length !== Number(sizeText)) throw new NativeGitObjectBytesError("native Git blob size changed");
  assertObjectId(input.git.objectFormat, "blob", bytes, input.objectId);
  return bytes;
}

export function assertObjectId(objectFormat: GitObjectFormat, type: "blob" | "commit" | "tree",
  bytes: Buffer, expected: string): void {
  const digest = createHash(objectFormatProperties[objectFormat].hashAlgorithm)
    .update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
  if (digest !== expected) throw new NativeGitObjectBytesError(`native Git ${type} identity does not match its bytes`);
}

export class NativeGitObjectBytesError extends Error {
  readonly name = "NativeGitObjectBytesError";
}
