import type { AuthoritativeNativeDecisions } from "./authoritative-native-decision-store.js";

export type NativeHumanReviewStatus = "pending" | "approved" | "revoked" | "stale";

export function nativeHumanReviewStatus(
  requiredReviewerIds: readonly string[],
  staleReasons: readonly string[],
  decisions: AuthoritativeNativeDecisions
): NativeHumanReviewStatus {
  if (staleReasons.length > 0) return "stale";
  const activeReviewers = new Set(decisions.activeApprovals.map((approval) => approval.reviewerId));
  if (requiredReviewerIds.every((reviewerId) => activeReviewers.has(reviewerId))) return "approved";
  return decisions.revocations.length > 0 ? "revoked" : "pending";
}
