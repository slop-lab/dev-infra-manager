import {
  gitCiStatusSchema,
  type GitCiStatus,
  type GitReview,
} from "@slop-lab/gs-client";
import {
  decodeDimLegacyReviewEnvelope,
} from "@slop-lab/gs-review-contracts/dim-legacy-codec";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const decisionStatus = z.enum(["pending", "approved", "revoked", "stale"]);
const approvalWireSchema = z.object({ approvalId: digest, reviewerId: identifier, approvedAt: z.string().datetime() }).passthrough();
const revocationWireSchema = z.object({ approvalId: digest, revokedAt: z.string().datetime() }).passthrough();
const envelopeWireSchema = z.object({
  schemaVersion: z.literal(3),
  envelopeId: digest,
  review: z.unknown(),
  policyDigest: digest,
  attachments: z.array(z.unknown()).max(64),
}).passthrough();
const ciWireSchema = z.object({
  schemaVersion: z.literal(1),
  reviewId: digest,
  generationId: digest,
  candidateCommit: objectId,
  expectedProtectedHead: objectId,
  policy: z.enum(["absent", "enabled", "unknown"]),
  state: z.enum(["not-configured", "not-required", "pending", "failed", "succeeded", "stale", "unavailable"]),
  requiredJobs: z.array(z.object({
    name: identifier,
    kind: z.enum(["ordinary-sysbox", "qemu"]),
    status: z.enum(["pending", "failed", "succeeded", "stale", "unavailable"]),
    executionId: z.string().uuid().optional(),
  }).strict()).max(64),
  reason: z.enum(["invalid-plan", "stale-review", "evidence-unavailable", "inspection-unavailable"]).optional(),
}).strict();

export function decodeDimResolvedReview(value: unknown): unknown {
  return decodeDimLegacyReviewEnvelope(value);
}

export function decodeDimReviewDetail(value: unknown): {
  readonly review: unknown;
  readonly status: GitReview["status"];
  readonly staleReasons: readonly string[];
  readonly approvals: GitReview["approvals"];
  readonly revocations: GitReview["revocations"];
} {
  const row = envelopeWireSchema.extend({
    status: decisionStatus,
    staleReasons: z.array(z.string()).max(256),
    approvals: z.array(approvalWireSchema).max(5_000),
    revocations: z.array(revocationWireSchema).max(5_000),
  }).parse(value);
  const envelope = decodeDimLegacyReviewEnvelope({
    schemaVersion: row.schemaVersion,
    envelopeId: row.envelopeId,
    review: row.review,
    policyDigest: row.policyDigest,
    attachments: row.attachments,
  });
  return {
    review: envelope.review,
    status: row.status,
    staleReasons: row.staleReasons,
    approvals: row.approvals.map(({ approvalId, reviewerId, approvedAt }) => ({ approvalId, reviewerId, approvedAt })),
    revocations: row.revocations.map(({ approvalId, revokedAt }) => ({ approvalId, revokedAt })),
  };
}

export function decodeDimCiStatus(value: unknown): GitCiStatus {
  const status = ciWireSchema.parse(value);
  return gitCiStatusSchema.parse({
    schemaVersion: status.schemaVersion,
    reviewId: status.reviewId,
    candidateCommit: status.candidateCommit,
    expectedProtectedHead: status.expectedProtectedHead,
    policy: status.policy,
    state: status.state,
    requiredChecks: status.requiredJobs.map((job) => ({
      name: job.name,
      provider: job.kind,
      status: job.status,
      ...(job.executionId === undefined ? {} : { runId: job.executionId }),
    })),
    ...(status.reason === undefined ? {} : { reason: status.reason }),
  });
}
