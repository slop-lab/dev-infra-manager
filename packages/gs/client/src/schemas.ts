import { reviewCiJobSchema, reviewCiStatusSchema } from "@slop-lab/gs-ci-contracts";
import { authoritativeNativeReviewEnvelopeSchema } from "@slop-lab/gs-review-contracts";
import { z } from "zod";

const MAX_CHANGES = 5_000;
const MAX_EVIDENCE_ENTRIES = 5_000;
const MAX_PATCH_CODE_UNITS = 8 * 1024 * 1024;
const MAX_PATH_CODE_UNITS = 16 * 1024;
const MAX_SYMLINK_TARGET_CODE_UNITS = 64 * 1024;
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const displayText = (maximum: number) => z.string().max(maximum).refine((value) => !/[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/u.test(value));
const patchText = z.string().max(MAX_PATCH_CODE_UNITS).refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/u.test(value));

const changedPathSchema = z.object({
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type-changed"]),
  oldPath: displayText(MAX_PATH_CODE_UNITS).min(1).optional(),
  newPath: displayText(MAX_PATH_CODE_UNITS).min(1).optional(),
  oldMode: z.string().regex(/^[0-7]{6}$/),
  newMode: z.string().regex(/^[0-7]{6}$/),
  oldObjectId: objectId.or(z.literal("0")),
  newObjectId: objectId.or(z.literal("0")),
  similarity: z.number().int().min(0).max(100).optional(),
  oldSymlinkTarget: displayText(MAX_SYMLINK_TARGET_CODE_UNITS).optional(),
  newSymlinkTarget: displayText(MAX_SYMLINK_TARGET_CODE_UNITS).optional(),
}).strip().readonly();
const approvalSchema = z.object({ approvalId: digest, reviewerId: identifier, approvedAt: z.string().datetime() }).strip().readonly();
const revocationSchema = z.object({ approvalId: digest, revokedAt: z.string().datetime() }).strip().readonly();

export const gitCiStatusSchema = z.object({
  schemaVersion: z.literal(1),
  reviewId: digest,
  candidateCommit: objectId,
  expectedProtectedHead: objectId,
  policy: z.enum(["absent", "enabled", "unknown"]),
  state: z.enum(["not-configured", "not-required", "pending", "failed", "succeeded", "stale", "unavailable"]),
  requiredJobs: z.array(reviewCiJobSchema).max(64).readonly(),
  reason: z.enum(["invalid-plan", "stale-review", "evidence-unavailable", "inspection-unavailable"]).optional(),
}).strict().superRefine((status, context) => {
  if (status.state === "succeeded" && (status.policy !== "enabled" || status.requiredJobs.length === 0
    || status.requiredJobs.some((job) => job.status !== "succeeded"))) {
    context.addIssue({ code: "custom", message: "successful CI requires successful evidence for every required job" });
  }
  if ((status.state === "not-configured" && (status.policy !== "absent" || status.requiredJobs.length !== 0))
    || (status.state === "not-required" && (status.policy !== "enabled" || status.requiredJobs.length !== 0))) {
    context.addIssue({ code: "custom", message: "CI requirement state conflicts with policy" });
  }
}).readonly();

const reviewSchema = z.object({
  schemaVersion: z.literal(2),
  namespaceId: identifier,
  repositoryId: identifier,
  protectedRef: displayText(1024).min(1),
  proposalRef: displayText(1024).min(1),
  expectedProtectedHead: objectId,
  inputs: z.record(identifier, z.object({ commit: objectId, tree: objectId }).strict()),
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: displayText(1024),
  requiredReviewRevision: displayText(1024),
  workspaceId: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  requiredReviewerIds: z.array(identifier).max(256).readonly(),
  changes: z.array(changedPathSchema).max(MAX_CHANGES).readonly(),
  patch: patchText,
  reviewId: digest,
  createdAt: z.string().datetime(),
  status: z.enum(["pending", "approved", "revoked", "stale"]),
  staleReasons: z.array(displayText(1024)).max(256).readonly(),
  approvals: z.array(approvalSchema).max(MAX_EVIDENCE_ENTRIES).readonly(),
  revocations: z.array(revocationSchema).max(MAX_EVIDENCE_ENTRIES).readonly(),
  ci: z.union([reviewCiStatusSchema, gitCiStatusSchema]).optional(),
}).strip().readonly();

export type GitCiStatus = z.infer<typeof gitCiStatusSchema>;
export type GitReview = Omit<z.infer<typeof reviewSchema>, "ci"> & { readonly ci?: GitCiStatus };
export type PromotionReceipt = z.infer<typeof promotionSchema>;

export const preparedPullRequestReviewSchema = z.object({
  pullRequestId: z.string().min(1).max(256),
  revisionId: z.string().min(1).max(256),
  review: authoritativeNativeReviewEnvelopeSchema,
}).strict().readonly();
export type PreparedPullRequestReview = z.infer<typeof preparedPullRequestReviewSchema>;

export function parseGitCiStatus(value: unknown): GitCiStatus {
  const { generationId: _generationId, ...status } = reviewCiStatusSchema.parse(value);
  return gitCiStatusSchema.parse(status);
}

export function parseGitReview(value: unknown): GitReview {
  const row = z.record(z.string(), z.unknown()).parse(value);
  const envelope = row.schemaVersion === 3
    ? z.object({ review: z.record(z.string(), z.unknown()), status: z.unknown(), staleReasons: z.unknown(), approvals: z.unknown(), revocations: z.unknown() }).passthrough().parse(row)
    : { review: row, status: row.status, staleReasons: row.staleReasons, approvals: row.approvals, revocations: row.revocations };
  const parsed = reviewSchema.parse({ ...envelope.review, status: envelope.status, staleReasons: envelope.staleReasons, approvals: envelope.approvals, revocations: envelope.revocations });
  const { ci, ...review } = parsed;
  if (ci === undefined) return review;
  return { ...review, ci: "generationId" in ci ? parseGitCiStatus(ci) : gitCiStatusSchema.parse(ci) };
}

export const reviewSummarySchema = z.object({
  reviewId: digest,
  proposalRef: displayText(1024),
  protectedRef: displayText(1024),
  candidateCommit: objectId,
  createdAt: z.string().datetime(),
  status: z.string().max(64),
}).strict().readonly();
export const promotionSchema = z.object({ schemaVersion: z.literal(1), outcome: z.enum(["promoted", "already-current"]), reviewId: digest,
  protectedRef: z.string().startsWith("refs/heads/"), expectedProtectedHead: objectId, candidateCommit: objectId, candidateTree: objectId }).strip().readonly();
export const preparedMergeSchema = z.object({ schemaVersion: z.literal(1), outcome: z.enum(["proposed", "unchanged", "conflict"]),
  sourceRef: z.string().startsWith("refs/heads/"), targetRef: z.string().startsWith("refs/heads/"), sourceCommit: objectId,
  expectedProtectedHead: objectId, proposalRef: z.string().startsWith("refs/heads/proposals/").optional(), candidateCommit: objectId.optional(), reviewId: digest.optional() }).strict().readonly();
const upstream = { upstreamRef: z.string().startsWith("refs/remotes/upstream/").max(1024), upstreamCommit: objectId, expectedProtectedHead: objectId };
export const syncResultSchema = z.discriminatedUnion("outcome", [
  z.object({ schemaVersion: z.literal(1), outcome: z.literal("published"), sourceCommit: objectId, targetRef: z.string().startsWith("refs/heads/").max(1024) }).strict(),
  ...(["fetched", "unchanged", "conflict"] as const).map((outcome) => z.object({ schemaVersion: z.literal(1), outcome: z.literal(outcome), ...upstream }).strict()),
  z.object({ schemaVersion: z.literal(1), outcome: z.literal("proposed"), ...upstream, proposalRef: z.string().startsWith("refs/").max(1024), candidateCommit: objectId }).strict(),
]);
