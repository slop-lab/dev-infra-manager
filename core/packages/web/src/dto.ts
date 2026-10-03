import { z } from "zod";
import { printablePatch, printableText } from "./text-schema.js";

const MAX_CHANGES = 5_000;
const MAX_EVIDENCE_ENTRIES = 5_000;
const MAX_PATCH_CODE_UNITS = 8 * 1024 * 1024;
const MAX_PATH_CODE_UNITS = 16 * 1024;
const MAX_SYMLINK_TARGET_CODE_UNITS = 64 * 1024;
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const revision = printableText(1024);
const changedPath = z.object({
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type-changed"]),
  oldPath: printableText(MAX_PATH_CODE_UNITS).min(1).optional(), newPath: printableText(MAX_PATH_CODE_UNITS).min(1).optional(),
  oldMode: z.string().regex(/^[0-7]{6}$/), newMode: z.string().regex(/^[0-7]{6}$/),
  oldObjectId: objectId.or(z.literal("0")), newObjectId: objectId.or(z.literal("0")),
  similarity: z.number().int().min(0).max(100).optional(),
  oldSymlinkTarget: printableText(MAX_SYMLINK_TARGET_CODE_UNITS).optional(),
  newSymlinkTarget: printableText(MAX_SYMLINK_TARGET_CODE_UNITS).optional()
}).passthrough();
const approval = z.object({ approvalId: z.string().uuid(), reviewerId: identifier, approvedAt: z.string().datetime() }).passthrough();
const revocation = z.object({ approvalId: z.string().uuid(), revokedAt: z.string().datetime() }).passthrough();
const status = z.object({
  statusId: digest, occurredAt: z.string().datetime(), reportedAt: z.string().datetime(),
  payload: z.object({ jobName: identifier, attempt: z.number().int().positive(), result: z.enum(["success", "failure", "cancelled"]) }).passthrough()
}).passthrough();
const nativeReview = z.object({
  schemaVersion: z.literal(1), projectId: identifier, repositoryId: identifier,
  protectedRef: printableText(1024).min(1), proposalRef: printableText(1024).min(1), expectedProtectedHead: objectId,
  candidateCommit: objectId, candidateTree: objectId, policyRevision: revision,
  requiredReviewRevision: revision, requiredJobSetRevision: revision, workspaceId: identifier,
  requiredReviewerIds: z.array(identifier).max(256).readonly(), changes: z.array(changedPath).max(MAX_CHANGES).readonly(),
  patch: printablePatch(MAX_PATCH_CODE_UNITS), reviewId: digest, createdAt: z.string().datetime(),
  status: z.enum(["pending", "approved", "revoked", "stale"]),
  staleReasons: z.array(printableText(1024)).max(256).readonly(),
  approvals: z.array(approval).max(MAX_EVIDENCE_ENTRIES).readonly(),
  revocations: z.array(revocation).max(MAX_EVIDENCE_ENTRIES).readonly(),
  statuses: z.array(status).max(MAX_EVIDENCE_ENTRIES).readonly()
}).passthrough();

export type ReviewDto = ReturnType<typeof reviewDto>;

export function reviewDto(input: unknown) {
  const review = nativeReview.parse(input);
  return {
    schemaVersion: review.schemaVersion, projectId: review.projectId, repositoryId: review.repositoryId,
    protectedRef: review.protectedRef, proposalRef: review.proposalRef,
    expectedProtectedHead: review.expectedProtectedHead, candidateCommit: review.candidateCommit,
    candidateTree: review.candidateTree, policyRevision: review.policyRevision,
    requiredReviewRevision: review.requiredReviewRevision, requiredJobSetRevision: review.requiredJobSetRevision,
    workspaceId: review.workspaceId, requiredReviewerIds: review.requiredReviewerIds,
    changes: review.changes.map((change) => ({
      status: change.status, ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
      ...(change.newPath === undefined ? {} : { newPath: change.newPath }), oldMode: change.oldMode,
      newMode: change.newMode, oldObjectId: change.oldObjectId, newObjectId: change.newObjectId,
      ...(change.similarity === undefined ? {} : { similarity: change.similarity }),
      ...(change.oldSymlinkTarget === undefined ? {} : { oldSymlinkTarget: change.oldSymlinkTarget }),
      ...(change.newSymlinkTarget === undefined ? {} : { newSymlinkTarget: change.newSymlinkTarget })
    })),
    patch: review.patch, reviewId: review.reviewId, createdAt: review.createdAt, status: review.status,
    staleReasons: review.staleReasons,
    approvals: review.approvals.map(({ approvalId, reviewerId, approvedAt }) => ({ approvalId, reviewerId, approvedAt })),
    revocations: review.revocations.map(({ approvalId, revokedAt }) => ({ approvalId, revokedAt })),
    statuses: review.statuses.map((entry) => ({
      statusId: entry.statusId, occurredAt: entry.occurredAt, reportedAt: entry.reportedAt,
      jobName: entry.payload.jobName, attempt: entry.payload.attempt, result: entry.payload.result
    }))
  };
}
