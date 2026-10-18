import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nativeQemuDescriptorDigest, type NativeQemuDescriptor } from "./nativeQemuAssignment.js";
import {
  NativeHostVerificationError,
  type NativeCandidateReadAuthority
} from "./nativeOrdinaryCandidateVerifier.js";

export type NativeQemuCandidateVerificationInput = {
  readonly authority: NativeCandidateReadAuthority;
  readonly descriptor: NativeQemuDescriptor;
  readonly descriptorDigest: string;
  readonly workspace: string;
  readonly scriptFile: string;
  readonly signal: AbortSignal;
};

export async function verifyAndMaterializeNativeQemuCandidate(
  input: NativeQemuCandidateVerificationInput
): Promise<void> {
  if (nativeQemuDescriptorDigest(input.descriptor) !== input.descriptorDigest) {
    throw new NativeHostVerificationError("claim descriptor digest does not match its descriptor");
  }
  const descriptor = input.descriptor;
  const identity = { projectId: descriptor.projectId, repositoryId: descriptor.repositoryId };
  const protectedHead = await input.authority.resolveProtectedHead({
    ...identity, protectedRef: descriptor.protectedRef, signal: input.signal
  });
  if (protectedHead !== descriptor.expectedProtectedHead) {
    throw new NativeHostVerificationError("protected head identity changed");
  }
  const commit = await input.authority.readCommit({
    ...identity, objectId: descriptor.candidateCommit, signal: input.signal
  });
  if (commit.objectId !== descriptor.candidateCommit || commit.treeObjectId !== descriptor.candidateTree) {
    throw new NativeHostVerificationError("candidate commit does not identify the descriptor tree");
  }
  const config = await input.authority.readBlob({
    ...identity, treeObjectId: descriptor.candidateTree, path: descriptor.configBlob.path,
    maximumBytes: 64 * 1024, signal: input.signal
  });
  assertBlob(config, descriptor.configBlob, 64 * 1024, "config");
  const script = await input.authority.readBlob({
    ...identity, treeObjectId: descriptor.candidateTree, path: descriptor.script.path,
    maximumBytes: 1024 * 1024, signal: input.signal
  });
  assertBlob(script, descriptor.script, 1024 * 1024, "script");
  const materialized = await input.authority.materializeTree({
    ...identity, commitObjectId: descriptor.candidateCommit, treeObjectId: descriptor.candidateTree,
    destination: input.workspace, signal: input.signal
  });
  if (materialized.commitObjectId !== descriptor.candidateCommit
    || materialized.treeObjectId !== descriptor.candidateTree) {
    throw new NativeHostVerificationError("materialized candidate identity does not match the descriptor");
  }
  await mkdir(dirname(input.scriptFile), { recursive: true, mode: 0o700 });
  await writeFile(input.scriptFile, script.bytes, { mode: 0o400, flag: "wx" });
  await chmod(input.scriptFile, 0o400);
}

function assertBlob(
  blob: { readonly objectId: string; readonly mode: "100644" | "100755"; readonly bytes: Buffer },
  expected: { readonly objectId: string; readonly sha256: string },
  maximumBytes: number,
  label: string
): void {
  if (blob.bytes.length > maximumBytes || blob.objectId !== expected.objectId
    || digest(blob.bytes) !== expected.sha256) {
    throw new NativeHostVerificationError(`candidate ${label} blob does not match the descriptor`);
  }
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function invalid(message: string): never {
  throw new NativeHostVerificationError(`candidate config ${message}`);
}
