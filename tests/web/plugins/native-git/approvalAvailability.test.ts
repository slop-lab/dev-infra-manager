import { expect, it } from "vitest";
import { reviewApprovalAvailability } from "../../../../packages/web/plugins/native-git/src/assets/panel.js";
import type { ReviewDto } from "@slop-lab/dim-service-client-native-git";

const pending: Pick<ReviewDto, "status" | "requiredReviewerIds" | "approvals" | "revocations"> = { status: "pending", requiredReviewerIds: ["owner"], approvals: [], revocations: [] };
const access = { reviewerId: "owner", browserCanApprove: true, controllerCanApprove: true };
it("distinguishes missing browser reviewer access from unavailable backend authority and a different reviewer identity", () => {
  expect(reviewApprovalAvailability(pending, { ...access, browserCanApprove: false })).toMatchObject({ state: "role-required", message: expect.stringContaining("current password") });
  expect(reviewApprovalAvailability(pending, { ...access, controllerCanApprove: false })).toMatchObject({ state: "connection-required" });
  expect(reviewApprovalAvailability(pending, { ...access, reviewerId: "someone-else" })).toMatchObject({ state: "identity-mismatch", message: expect.stringContaining("owner") });
  expect(reviewApprovalAvailability(pending, access)).toMatchObject({ state: "available" });
});
it("keeps stale reviews, unnecessary approvals and existing exact approvals disabled, while revocation permits a new decision", () => {
  expect(reviewApprovalAvailability({ ...pending, status: "stale" }, access)).toMatchObject({ state: "stale" });
  expect(reviewApprovalAvailability({ ...pending, requiredReviewerIds: [] }, access)).toMatchObject({ state: "not-required" });
  const approved = { ...pending, approvals: [{ approvalId: "a".repeat(64), reviewerId: "owner", approvedAt: "2026-10-22T00:00:00.000Z" }] };
  expect(reviewApprovalAvailability(approved, access)).toMatchObject({ state: "already-approved" });
  expect(reviewApprovalAvailability({ ...approved, revocations: [{ approvalId: "a".repeat(64), revokedAt: "2026-10-22T01:00:00.000Z" }] }, access)).toMatchObject({ state: "available" });
});
