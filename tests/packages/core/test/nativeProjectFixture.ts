import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { compileNativeRepositoryBootstrapPolicy } from "../../../../core/packages/managed/src/nativeRootBootstrapPolicy.js";
import { parseNativeProjectPendingRecord, type NativeProjectRecord, type NativeProjectRepositoryRecord } from "../../../../core/packages/managed/src/nativeProjectPendingCodec.js";
import type { NativeWorkspaceAttachment, NativeWorkspaceRepositoryProof } from "../../../../core/packages/managed/src/nativeWorkspaceAttachment.js";

export function repositoryRecord(repositoryId = "public"): NativeProjectRepositoryRecord {
  const policy = compileNativeRepositoryBootstrapPolicy({ repositoryId, protectedRef: "refs/heads/main",
    review: { ciRepositoryIds: [repositoryId], requiredReviewerIds: ["owner"], requiredJobs: [], pathReviewerRules: [] } }).reviewPolicy;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const commit = digest(`${repositoryId}-commit`).slice(0, 40), tree = digest(`${repositoryId}-tree`).slice(0, 40);
  return { repositoryId, phase: "ready", protectedRef: "refs/heads/main", commit, tree, reviewPolicy: policy,
    bundleDigest: digest(repositoryId), bundleSize: 123, readyAt: "2026-10-19T00:00:00.000Z",
    importReceipt: { schemaVersion: 1, serviceId: "native-main", projectId: "project-a", repositoryId,
      generationId: "a".repeat(64), importNonce: "00000000-0000-4000-8000-000000000000", protectedRef: "refs/heads/main",
      expectedCommit: commit, resolvedTree: tree, policyDigest: digest(JSON.stringify(policy)), bundleDigest: digest(repositoryId), bundleSize: 123, phase: "repository-imported" } };
}
export function projectRecord(ids: readonly string[] = ["public", "private"]): NativeProjectRecord {
  return parseNativeProjectPendingRecord({ schemaVersion: 7, recordType: "native-project", name: "acme", projectId: "project-a",
    serviceId: "native-main", ownerHostId: "host-a", phase: "ready", configurationRepositoryId: ids[0], defaultWorkingRepositoryId: ids[0],
    repositories: Object.fromEntries(ids.map((id) => [id, repositoryRecord(id)])), readyAt: "2026-10-19T00:00:00.000Z" });
}
export function repositoryBinding(repository: NativeProjectRepositoryRecord): NativeWorkspaceRepositoryProof {
  return { repositoryId: repository.repositoryId, protectedRef: repository.protectedRef, commit: repository.commit, tree: repository.tree,
    policyRevision: repository.reviewPolicy.policyRevision, requiredReviewRevision: repository.reviewPolicy.requiredReviewRevision,
    requiredJobSetRevision: repository.reviewPolicy.requiredJobSetRevision };
}
export function attachmentRecord(root: string, workspaceId: string, workspaceName = "development"): NativeWorkspaceAttachment {
  const repository = repositoryRecord("public");
  return { schemaVersion: 2, workspaceId, workspaceName, projectName: "acme", projectId: "project-a",
    configuration: repositoryBinding(repository), repositories: { public: { ...repositoryBinding(repository),
      nativeWorkspaceId: randomBytes(32).toString("base64url"), grant: randomBytes(32).toString("base64url") } },
    connectionFile: path.join(root, "host.json"), managedStateRoot: root, workspaceStateRoot: root, gateway: "127.0.0.1", port: 19419 };
}
