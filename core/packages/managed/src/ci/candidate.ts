import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserError } from "@slop-lab/dim-core";
import { executionDescriptorSchema, executionDescriptorDigest, type ExecutionDescriptor } from "@slop-lab/dim-plugin-control-plane-native-git/execution";

export type NativeCandidateBlob = {
  readonly objectId: string;
  readonly mode: "100644" | "100755";
  readonly bytes: Buffer;
};

export interface NativeCandidateReadAuthority {
  resolveProtectedHead(input: { readonly projectId: string; readonly repositoryId: string; readonly protectedRef: string; readonly signal: AbortSignal }): Promise<string>;
  readCommit(input: { readonly projectId: string; readonly repositoryId: string; readonly objectId: string; readonly signal: AbortSignal }): Promise<{ readonly objectId: string; readonly treeObjectId: string }>;
  readBlob(input: { readonly projectId: string; readonly repositoryId: string; readonly treeObjectId: string; readonly path: string; readonly maximumBytes: number; readonly signal: AbortSignal }): Promise<NativeCandidateBlob>;
  materializeTree(input: { readonly projectId: string; readonly repositoryId: string; readonly commitObjectId: string; readonly treeObjectId: string; readonly destination: string; readonly signal: AbortSignal }): Promise<{ readonly commitObjectId: string; readonly treeObjectId: string }>;
}

export type NativeCandidateVerificationInput = {
  readonly authority: NativeCandidateReadAuthority;
  readonly descriptor: ExecutionDescriptor;
  readonly descriptorDigest: string;
  readonly workspace: string;
  readonly scriptFile: string;
  readonly signal: AbortSignal;
};

export async function verifyAndMaterializeCandidate(input: NativeCandidateVerificationInput): Promise<void> {
  let descriptor: ExecutionDescriptor;
  try {
    descriptor = executionDescriptorSchema.parse(input.descriptor);
  } catch (error) {
    if (error instanceof UserError) throw new NativeHostVerificationError("claim descriptor is invalid", { cause: error });
    throw error;
  }
  if (executionDescriptorDigest(descriptor) !== input.descriptorDigest) {
    throw new NativeHostVerificationError("claim descriptor digest does not match its descriptor");
  }
  const identity = { projectId: descriptor.projectId, repositoryId: descriptor.repositoryId };
  const protectedHead = await input.authority.resolveProtectedHead({
    ...identity, protectedRef: descriptor.protectedRef, signal: input.signal
  });
  if (protectedHead !== descriptor.expectedProtectedHead) throw new NativeHostVerificationError("protected head identity changed");
  const commit = await input.authority.readCommit({ ...identity, objectId: descriptor.candidateCommit, signal: input.signal });
  if (commit.objectId !== descriptor.candidateCommit || commit.treeObjectId !== descriptor.candidateTree) {
    throw new NativeHostVerificationError("candidate commit does not identify the descriptor tree");
  }
  const config = await input.authority.readBlob({
    ...identity, treeObjectId: descriptor.candidateTree, path: descriptor.configBlob.path, maximumBytes: 64 * 1024,
    signal: input.signal
  });
  assertBlob(config, descriptor.configBlob, 64 * 1024, "config");
  const script = await input.authority.readBlob({
    ...identity, treeObjectId: descriptor.candidateTree, path: descriptor.script.path, maximumBytes: 1024 * 1024,
    signal: input.signal
  });
  assertBlob(script, descriptor.script, 1024 * 1024, "script");
  const primary = descriptor.inputs[descriptor.repositoryId];
  if (!Object.hasOwn(descriptor.inputs, descriptor.repositoryId) || primary?.commit !== descriptor.candidateCommit || primary.tree !== descriptor.candidateTree) {
    throw new NativeHostVerificationError("primary repository is missing from execution inputs");
  }
  await mkdir(input.workspace, { mode: 0o700 });
  for (const [repositoryId, snapshot] of Object.entries(descriptor.inputs)) {
    const selected = { projectId: descriptor.projectId, repositoryId };
    if (repositoryId !== descriptor.repositoryId) {
      const commit = await input.authority.readCommit({ ...selected, objectId: snapshot.commit, signal: input.signal });
      if (commit.objectId !== snapshot.commit || commit.treeObjectId !== snapshot.tree) throw new NativeHostVerificationError("input repository commit does not match snapshot");
    }
    const materialized = await input.authority.materializeTree({ ...selected, commitObjectId: snapshot.commit,
      treeObjectId: snapshot.tree, destination: join(input.workspace, repositoryId), signal: input.signal });
    if (materialized.commitObjectId !== snapshot.commit || materialized.treeObjectId !== snapshot.tree) {
      throw new NativeHostVerificationError("materialized input identity does not match descriptor");
    }
  }
  await writeFile(input.scriptFile, script.bytes, { mode: 0o400, flag: "wx" });
  await chmod(input.scriptFile, 0o400);
}

function assertBlob(
  blob: NativeCandidateBlob,
  expected: { readonly objectId: string; readonly sha256: string },
  maximumBytes: number,
  label: string
): void {
  if ((blob.mode !== "100644" && blob.mode !== "100755") || blob.bytes.length > maximumBytes
    || blob.objectId !== expected.objectId || sha256(blob.bytes) !== expected.sha256) {
    throw new NativeHostVerificationError(`candidate ${label} blob does not match the descriptor`);
  }
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export class NativeHostVerificationError extends UserError {
  readonly name = "NativeHostVerificationError";
}
