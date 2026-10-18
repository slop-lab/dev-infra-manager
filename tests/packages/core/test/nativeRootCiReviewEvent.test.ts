import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalNativeRootCiReviewEvent,
  NativeRootCiReviewEventError,
  parseNativeRootCiReviewEvent
} from "../../../../core/packages/managed/src/nativeRootCiReviewEvent.js";

describe("native root CI review event parser", () => {
  it("canonicalizes the exact schema-3 ordinary event for proof and receipt use", () => {
    // Given
    const input = event();

    // When
    const parsed = parseNativeRootCiReviewEvent(input);

    // Then
    expect(canonicalNativeRootCiReviewEvent(parsed)).toBe(JSON.stringify(input));
  });

  it.each([
    ["legacy schema", { ...event(), schemaVersion: 2 }],
    ["qemu", { ...event(), executionKind: "qemu" }],
    ["extra field", { ...event(), extra: true }],
    ["executable input", { ...event(), argv: ["sh"] }],
    ["changed canonical event", { ...event(), jobName: "changed" }]
  ])("rejects %s", (_label, input) => {
    // Given / When / Then
    expect(() => parseNativeRootCiReviewEvent(input)).toThrow(NativeRootCiReviewEventError);
  });
});

function event() {
  const reviewId = "1".repeat(64);
  const envelopeId = "9".repeat(64);
  const jobName = "source";
  const eventId = createHash("sha256").update("dim-native-authoritative-review-event-v3\0")
    .update(JSON.stringify({ envelopeId, executionKind: "ordinary-sysbox", jobName })).digest("hex");
  return { schemaVersion: 3, type: "dim.native.review-job.available", eventId, projectId: "project-a",
    repositoryId: "root", protectedRef: "refs/heads/main", reviewId, envelopeId, expectedProtectedHead: "1".repeat(40),
    candidateCommit: "2".repeat(40), candidateTree: "3".repeat(40), policyRevision: "4".repeat(64),
    requiredReviewRevision: "5".repeat(64), qualityRevision: "6".repeat(64),
    executionKind: "ordinary-sysbox", jobName, evidenceClass: "candidate-controlled" };
}
