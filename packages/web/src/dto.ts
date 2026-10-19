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
const approval = z.object({ approvalId: digest, reviewerId: identifier, approvedAt: z.string().datetime() }).passthrough();
const revocation = z.object({ approvalId: digest, revokedAt: z.string().datetime() }).passthrough();
const nativeReview = z.object({
  schemaVersion: z.literal(2), projectId: identifier, repositoryId: identifier,
  protectedRef: printableText(1024).min(1), proposalRef: printableText(1024).min(1), expectedProtectedHead: objectId,
  inputs: z.record(identifier, z.object({ commit: objectId, tree: objectId }).strict()),
  candidateCommit: objectId, candidateTree: objectId, policyRevision: revision,
  requiredReviewRevision: revision, qualityRevision: revision, workspaceId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  requiredReviewerIds: z.array(identifier).max(256).readonly(), changes: z.array(changedPath).max(MAX_CHANGES).readonly(),
  patch: printablePatch(MAX_PATCH_CODE_UNITS), reviewId: digest, createdAt: z.string().datetime(),
  status: z.enum(["pending", "approved", "revoked", "stale"]),
  staleReasons: z.array(printableText(1024)).max(256).readonly(),
  approvals: z.array(approval).max(MAX_EVIDENCE_ENTRIES).readonly(),
  revocations: z.array(revocation).max(MAX_EVIDENCE_ENTRIES).readonly()
}).passthrough();

export type ReviewDto = ReturnType<typeof reviewDto>;
export type AccountReviewDto = ReviewDto & { readonly canDecide: boolean };

export function accountReviewDto(review: ReviewDto, canDecide: boolean): AccountReviewDto {
  return { ...review, canDecide };
}

export function reviewDto(input: unknown) {
  const envelope = z.object({
    schemaVersion: z.literal(2), review: z.record(z.string(), z.unknown()), qualityRevision: revision,
    status: z.enum(["pending", "approved", "revoked", "stale"]), staleReasons: z.array(printableText(1024)),
    approvals: z.array(approval), revocations: z.array(revocation)
  }).parse(input);
  const review = nativeReview.parse({ ...envelope.review, qualityRevision: envelope.qualityRevision,
    status: envelope.status, staleReasons: envelope.staleReasons, approvals: envelope.approvals, revocations: envelope.revocations });
  return {
    schemaVersion: review.schemaVersion, projectId: review.projectId, repositoryId: review.repositoryId,
    protectedRef: review.protectedRef, proposalRef: review.proposalRef,
    expectedProtectedHead: review.expectedProtectedHead, candidateCommit: review.candidateCommit,
    inputs: review.inputs, candidateTree: review.candidateTree, policyRevision: review.policyRevision,
    requiredReviewRevision: review.requiredReviewRevision, qualityRevision: review.qualityRevision,
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
    revocations: review.revocations.map(({ approvalId, revokedAt }) => ({ approvalId, revokedAt }))
  };
}
