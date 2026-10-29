import { expect, it } from "vitest";
import {
  decodeDimReviewCiStatus,
  dimReviewCiStatusSchema,
  encodeDimReviewCiStatus,
} from "../../../packages/contracts/ci/src/review-status.js";
import { reviewCiStatusSchema } from "../../../packages/gs/ci-contracts/src/index.js";

it("keeps generation, worker kind and execution IDs in the DIM status codec", () => {
  const neutral = reviewCiStatusSchema.parse({
    schemaVersion: 1,
    reviewId: "a".repeat(64),
    candidateCommit: "b".repeat(40),
    expectedProtectedHead: "c".repeat(40),
    policy: "enabled",
    state: "pending",
    requiredChecks: [{
      name: "check",
      provider: "ordinary-sysbox",
      status: "pending",
      runId: "00000000-0000-4000-8000-000000000001",
    }],
  });
  const legacy = encodeDimReviewCiStatus(neutral, "d".repeat(64));

  expect(dimReviewCiStatusSchema.parse(legacy)).toMatchObject({
    generationId: "d".repeat(64),
    requiredJobs: [{ kind: "ordinary-sysbox", executionId: "00000000-0000-4000-8000-000000000001" }],
  });
  expect(decodeDimReviewCiStatus(legacy)).toEqual(neutral);
});
