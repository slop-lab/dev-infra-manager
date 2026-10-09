import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalNativeRootCiReviewEvent,
  NativeRootCiReviewEventError,
  parseNativeRootCiReviewEvent
} from "../../../../core/packages/core/src/nativeRootCiReviewEvent.js";

describe("native root CI review event parser", () => {
  it("canonicalizes the exact schema-2 ordinary event for proof and receipt use", () => {
    // Given
    const input = event();

    // When
    const parsed = parseNativeRootCiReviewEvent(input);

    // Then
    expect(canonicalNativeRootCiReviewEvent(parsed)).toBe(JSON.stringify(input));
  });

  it.each([
    ["legacy schema", { ...event(), schemaVersion: 1 }],
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
  const jobName = "source";
  const eventId = createHash("sha256").update("dim-native-authoritative-review-event-v1\0")
    .update(JSON.stringify({ executionKind: "ordinary-sysbox", jobName, reviewId })).digest("hex");
  return { schemaVersion: 2, type: "dim.native.review-job.available", eventId, projectId: "project-a",
    repositoryId: "root", protectedRef: "refs/heads/main", reviewId, expectedProtectedHead: "1".repeat(40),
    candidateCommit: "2".repeat(40), candidateTree: "3".repeat(40), policyRevision: "4".repeat(64),
    requiredReviewRevision: "5".repeat(64), requiredJobSetRevision: "6".repeat(64),
    executionKind: "ordinary-sysbox", jobName, evidenceClass: "candidate-controlled" };
}
