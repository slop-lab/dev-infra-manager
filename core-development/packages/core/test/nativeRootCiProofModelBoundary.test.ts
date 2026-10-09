import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseNativeRootCiReviewEventProof } from "../../../../core/packages/core/src/nativeRootCiProofModel.js";

describe("native root CI event policy binding", () => {
  it("rejects an ordinary event for a job bound to QEMU by the canonical policy", () => {
    // Given
    const generationId = "a".repeat(64);
    const requestId = "00000000-0000-4000-8000-000000000031";
    const importNonce = "00000000-0000-4000-8000-000000000032";
    const reviewId = "b".repeat(64);
    const requiredJobs = [{ name: "source", kind: "qemu", evidenceClass: "candidate-controlled" }] as const;
    const reviewers = { requiredReviewerIds: ["owner"], pathReviewerRules: [] } as const;
    const revision = (domain: string, version: number, value: unknown) => createHash("sha256")
      .update(`dim-native-${domain}-v${version}\0`).update(JSON.stringify(value)).digest("hex");
    const policy = {
      schemaVersion: 1, protectedRef: "refs/heads/main",
      policyRevision: revision("policy", 2, { protectedRef: "refs/heads/main", ...reviewers, requiredJobs }),
      requiredReviewRevision: revision("reviewers", 1, reviewers),
      requiredJobSetRevision: revision("jobs", 2, requiredJobs), requiredJobs, ...reviewers
    };
    const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
    const eventId = createHash("sha256").update("dim-native-authoritative-review-event-v1\0")
      .update(JSON.stringify({ executionKind: "ordinary-sysbox", jobName: "source", reviewId })).digest("hex");
    const selector = { projectId: "project-a", importNonce, policyDigest, eventId, reviewId,
      executionKind: "ordinary-sysbox" as const, jobName: "source" };
    const proof = {
      schemaVersion: 1, serviceId: "native-main", requestId, servingGenerationId: generationId,
      projectId: "project-a", repositoryId: "root", policy,
      currentRoot: { importNonce, sequence: 0, protectedRef: policy.protectedRef,
        commit: "c".repeat(40), tree: "d".repeat(40), policyDigest },
      reviewLiveness: "current",
      event: { schemaVersion: 2, type: "dim.native.review-job.available", eventId, projectId: "project-a",
        repositoryId: "root", protectedRef: policy.protectedRef, reviewId,
        expectedProtectedHead: "c".repeat(40), candidateCommit: "e".repeat(40), candidateTree: "f".repeat(40),
        policyRevision: policy.policyRevision, requiredReviewRevision: policy.requiredReviewRevision,
        requiredJobSetRevision: policy.requiredJobSetRevision, executionKind: "ordinary-sysbox",
        jobName: "source", evidenceClass: "candidate-controlled" }
    };

    // When / Then
    expect(() => parseNativeRootCiReviewEventProof(proof, { serviceId: "native-main", generationId,
      requestId, projectId: "project-a" }, selector)).toThrow();
  });
});
