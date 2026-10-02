import { createHash } from "node:crypto";
import { z } from "zod";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const mode = z.string().regex(/^[0-7]{6}$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);

export const changedPathSchema = z.object({
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "type-changed"]),
  oldPath: z.string().optional(),
  newPath: z.string().optional(),
  oldPathBytes: z.string(),
  newPathBytes: z.string(),
  oldMode: mode,
  newMode: mode,
  oldObjectId: objectId.or(z.literal("0")),
  newObjectId: objectId.or(z.literal("0")),
  similarity: z.number().int().min(0).max(100).optional(),
  oldSymlinkTarget: z.string().optional(),
  newSymlinkTarget: z.string().optional()
}).strict().readonly();

const reviewIdentityObjectSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: identifier,
  repositoryId: identifier,
  protectedRef: z.string(),
  proposalRef: z.string(),
  expectedProtectedHead: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  policyRevision: z.string(),
  requiredReviewRevision: z.string(),
  requiredJobSetRevision: z.string(),
  policyDigest: digest,
  writerUsername: z.string(),
  workspaceId: identifier,
  requiredReviewerIds: z.array(identifier).readonly(),
  changes: z.array(changedPathSchema).readonly(),
  patch: z.string(),
  patchBytes: z.string()
}).strict();

const reviewIdentitySchema = reviewIdentityObjectSchema.readonly();

export const reviewObjectSchema = reviewIdentityObjectSchema.extend({
  reviewId: digest,
  createdAt: z.string().datetime()
}).strict().readonly();

export const reviewApprovalSchema = z.object({
  schemaVersion: z.literal(1),
  approvalId: z.string().uuid(),
  reviewId: digest,
  reviewerId: identifier,
  reviewerUsername: z.string(),
  approvedAt: z.string().datetime()
}).strict().readonly();

export const reviewRevocationSchema = z.object({
  schemaVersion: z.literal(1),
  approvalId: z.string().uuid(),
  reviewId: digest,
  revokedBy: z.string(),
  revokedAt: z.string().datetime()
}).strict().readonly();

export type ChangedPath = z.infer<typeof changedPathSchema>;
export type ReviewIdentity = z.infer<typeof reviewIdentitySchema>;
export type ReviewObject = z.infer<typeof reviewObjectSchema>;
export type ReviewApproval = z.infer<typeof reviewApprovalSchema>;
export type ReviewRevocation = z.infer<typeof reviewRevocationSchema>;

export function reviewDigest(identity: ReviewIdentity): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(identity)), "utf8").digest("hex");
}

export function parseReviewObject(input: unknown): ReviewObject {
  const review = reviewObjectSchema.parse(input);
  const { reviewId, createdAt: _createdAt, ...identity } = review;
  if (reviewDigest(identity) !== reviewId) throw new ReviewRecordError("stored review identity digest is invalid");
  return review;
}

export class ReviewRecordError extends Error {
  readonly name = "ReviewRecordError";
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) canonical[key] = canonicalValue(Reflect.get(value, key));
  return canonical;
}
