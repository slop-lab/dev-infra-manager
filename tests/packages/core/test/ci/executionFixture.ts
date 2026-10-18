import { createHash, randomUUID } from "node:crypto";
import { executionGrantSchema, type ExecutionEvent, type ExecutionGrant, type ExecutionResult } from "../../../../../core/packages/native-git/src/execution-protocol.js";
import { descriptorDigest } from "../../../../../core/packages/native-git/src/candidate-execution.js";
import type { ExecutionAssignment, WorkerSlot } from "../../../../../core/packages/managed/src/ci/execution.js";
export const generation = "a".repeat(64);
export const slot: WorkerSlot = { id: "primary", kind: "ordinary-sysbox", profile: {
  runnerBaseImage: `registry.example/runner@sha256:${"b".repeat(64)}`,
  jobBaseImage: `registry.example/job@sha256:${"c".repeat(64)}`,
  bounds: { cpu: "1", memoryBytes: "536870912", pids: "128", wallClockSeconds: "30", outputBytes: "1024" }
} };
export function event(name = "source", kind: ExecutionEvent["executionKind"] = "ordinary-sysbox"): ExecutionEvent {
  return { schemaVersion: 3, type: "dim.native.review-job.available", eventId: hash(name + kind), envelopeId: "1".repeat(64),
    projectId: "project-a", repositoryId: "root", protectedRef: "refs/heads/main", reviewId: "2".repeat(64),
    expectedProtectedHead: "1".repeat(40), candidateCommit: "2".repeat(40), candidateTree: "3".repeat(40),
    policyRevision: "4".repeat(64), requiredReviewRevision: "5".repeat(64), qualityRevision: "6".repeat(64),
    executionKind: kind, jobName: name, evidenceClass: "candidate-controlled" };
}
export function grant(assignment: ExecutionAssignment): ExecutionGrant {
  const source = assignment.event;
  const descriptor = { projectId: source.projectId, repositoryId: "root" as const, protectedRef: source.protectedRef,
    expectedProtectedHead: source.expectedProtectedHead, candidateCommit: source.candidateCommit, candidateTree: source.candidateTree,
    policyRevision: source.policyRevision, requiredReviewRevision: source.requiredReviewRevision,
    requiredJobSetRevision: source.qualityRevision, admissionGeneration: assignment.generationId, jobName: source.jobName,
    evidenceClass: "candidate-controlled" as const,
    configBlob: { path: ".dim/ci/runner.yml", objectId: "4".repeat(40), sha256: `sha256:${hash("config")}` },
    script: { path: "scripts/check.sh", objectId: "5".repeat(40), sha256: `sha256:${hash("script")}` },
    argv: ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"],
    runnerBaseImage: assignment.profile.runnerBaseImage, jobImage: assignment.profile.jobBaseImage, bounds: assignment.profile.bounds };
  return executionGrantSchema.parse({ executionId: assignment.id, generationId: assignment.generationId, event: source,
    workerId: assignment.workerId, slotId: assignment.slotId, profile: assignment.profile, attempt: 1,
    issuedAt: new Date().toISOString(), descriptor, descriptorDigest: descriptorDigest(descriptor) });
}
export function assignment(): ExecutionAssignment {
  return { id: randomUUID(), event: event(), phase: "assigned", generationId: generation, createdAt: Date.now(),
    publication: "pending", workerId: "worker-a", slotId: slot.id, profile: slot.profile, requestId: randomUUID(),
    leaseToken: "token".repeat(16), leaseExpiresAt: Date.now() + 60_000 };
}
export function result(grant: ExecutionGrant): ExecutionResult {
  const now = new Date().toISOString();
  const empty = { bytes: "0", sha256: `sha256:${hash("")}`, truncated: false };
  return { executionId: grant.executionId, descriptorDigest: grant.descriptorDigest, cleanupComplete: true,
    startedAt: now, finishedAt: now, result: "success", completion: { kind: "exited", exitCode: 0 }, stdout: empty, stderr: empty };
}
export function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
