import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import { executionInputsSchema } from "@slop-lab/dim-contracts-ci/descriptor";
import { authoritativeNativeReviewEventSchema } from "@slop-lab/dim-contracts-ci/events";
export { authoritativeNativeReviewEventSchema } from "@slop-lab/dim-contracts-ci/events";
import { authoritativeNativeReviewSchema, authoritativeNativeReviewDigest, type AuthoritativeNativeReview, type AuthoritativeNativeReviewIdentity } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { isCandidatePath, isCandidateArgv } from "@slop-lab/dim-contracts-ci/workflow-plugin-api";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const jobName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

const authoritativeNativeRequiredJobObject = z.object({
  executionKind: z.enum(["ordinary-sysbox", "qemu"]), jobName, evidenceClass: z.literal("candidate-controlled")
}).strict();
export const authoritativeNativeRequiredJobSchema = authoritativeNativeRequiredJobObject.readonly();

const blobIdentityObject = z.object({ objectId, sha256 }).strict();
const plannedJob = authoritativeNativeRequiredJobObject.extend({
  script: blobIdentityObject.extend({ path: z.string().refine(isCandidatePath) }).strict().readonly(),
  argv: z.array(z.string()).refine(isCandidateArgv).readonly(),
  inputs: executionInputsSchema
}).strict().readonly();
export const gitCiPlanningSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid"), configBlob: blobIdentityObject.extend({ path: z.string().refine(isCandidatePath) }).strict().readonly().nullable(), jobs: z.array(plannedJob).max(64).readonly() }).strict().readonly(),
  z.object({ status: z.literal("invalid"), reason: z.literal("invalid-candidate-job-plan") }).strict().readonly()
]);

export const authoritativeNativeReviewEnvelopeSchema = z.object({
  schemaVersion: z.literal(2), envelopeId: digest, review: authoritativeNativeReviewSchema,
  qualityRevision: digest, policyDigest: digest,
  requiredJobs: z.array(authoritativeNativeRequiredJobSchema).max(64).readonly(), planning: gitCiPlanningSchema,
  events: z.array(authoritativeNativeReviewEventSchema).max(64).readonly()
}).strict().readonly();

export type { AuthoritativeNativeReview, AuthoritativeNativeReviewIdentity };
export type AuthoritativeNativeReviewEnvelope = z.infer<typeof authoritativeNativeReviewEnvelopeSchema>;
export type AuthoritativeNativePlanning = z.infer<typeof gitCiPlanningSchema>;

export function createAuthoritativeNativeReviewEnvelope(input: {
  readonly identity: AuthoritativeNativeReviewIdentity;
  readonly qualityRevision: string;
  readonly policyDigest: string;
  readonly requiredJobs: readonly z.infer<typeof authoritativeNativeRequiredJobSchema>[];
  readonly planning: AuthoritativeNativePlanning;
  readonly createdAt: string;
}): AuthoritativeNativeReviewEnvelope {
  assertSortedUnique(input.identity.requiredReviewerIds);
  assertSortedUnique(input.requiredJobs.map(jobKey));
  if (input.planning.status === "valid") assertSortedUnique(input.planning.jobs.map(jobKey));
  const review = authoritativeNativeReviewSchema.parse({ ...input.identity,
    reviewId: authoritativeNativeReviewDigest(input.identity), createdAt: input.createdAt });
  const envelopeIdentity = { reviewId: review.reviewId, qualityRevision: input.qualityRevision,
    policyDigest: input.policyDigest, requiredJobs: input.requiredJobs, planning: input.planning };
  const envelopeId = domainDigest("dim-native-authoritative-envelope-v2\0", envelopeIdentity);
  const events = input.planning.status === "valid" ? input.planning.jobs.map((job) => eventFor({
    review, envelopeId, qualityRevision: input.qualityRevision, job
  })) : [];
  return parseAuthoritativeNativeReviewEnvelope({ schemaVersion: 2, envelopeId, review,
    qualityRevision: input.qualityRevision, policyDigest: input.policyDigest,
    requiredJobs: input.requiredJobs, planning: input.planning, events });
}

export function parseAuthoritativeNativeReviewEnvelope(input: unknown): AuthoritativeNativeReviewEnvelope {
  const envelope = authoritativeNativeReviewEnvelopeSchema.parse(input);
  const { reviewId, createdAt: _createdAt, ...identity } = envelope.review;
  assertSortedUnique(identity.requiredReviewerIds);
  const primary = { commit: identity.candidateCommit, tree: identity.candidateTree };
  if (!Object.hasOwn(identity.inputs, identity.repositoryId) || !isDeepStrictEqual(identity.inputs[identity.repositoryId], primary)) invalid("primary repository snapshot");
  const plannedInputs: Record<string, { commit: string; tree: string }> = { [identity.repositoryId]: primary };
  if (envelope.planning.status === "valid") for (const job of envelope.planning.jobs) {
    if (!Object.hasOwn(job.inputs, identity.repositoryId) || !isDeepStrictEqual(job.inputs[identity.repositoryId], primary)) invalid("job primary snapshot");
    for (const [id, snapshot] of Object.entries(job.inputs)) {
      if (Object.hasOwn(plannedInputs, id) && !isDeepStrictEqual(plannedInputs[id], snapshot)) invalid("conflicting repository snapshots");
      plannedInputs[id] = snapshot;
    }
  }
  if (!isDeepStrictEqual(plannedInputs, identity.inputs)) invalid("review repository snapshot");
  assertSortedUnique(envelope.requiredJobs.map(jobKey));
  if (!identity.proposalRef.startsWith(`refs/heads/proposals/${identity.workspaceId}/`)
    || authoritativeNativeReviewDigest(identity) !== reviewId) invalid("review identity");
  if (envelope.planning.status === "valid") assertSortedUnique(envelope.planning.jobs.map(jobKey));
  const expectedEnvelopeId = domainDigest("dim-native-authoritative-envelope-v2\0", {
    reviewId, qualityRevision: envelope.qualityRevision, policyDigest: envelope.policyDigest,
    requiredJobs: envelope.requiredJobs, planning: envelope.planning
  });
  if (envelope.envelopeId !== expectedEnvelopeId) invalid("envelope identity");
  const expectedEvents = envelope.planning.status === "valid" ? envelope.planning.jobs.map((job) => eventFor({
    review: envelope.review, envelopeId: envelope.envelopeId, qualityRevision: envelope.qualityRevision, job
  })) : [];
  if (JSON.stringify(envelope.events) !== JSON.stringify(expectedEvents)) invalid("event set");
  return envelope;
}

function eventFor(input: { readonly review: AuthoritativeNativeReview; readonly envelopeId: string;
  readonly qualityRevision: string; readonly job: z.infer<typeof plannedJob> }) {
  const eventIdentity = { envelopeId: input.envelopeId, executionKind: input.job.executionKind,
    jobName: input.job.jobName };
  return authoritativeNativeReviewEventSchema.parse({ schemaVersion: 3, type: "dim.native.review-job.available",
    eventId: domainDigest("dim-native-authoritative-review-event-v3\0", eventIdentity),
    envelopeId: input.envelopeId, projectId: input.review.projectId, repositoryId: input.review.repositoryId,
    protectedRef: input.review.protectedRef, reviewId: input.review.reviewId,
    expectedProtectedHead: input.review.expectedProtectedHead, candidateCommit: input.review.candidateCommit,
    candidateTree: input.review.candidateTree, policyRevision: input.review.policyRevision,
    requiredReviewRevision: input.review.requiredReviewRevision, qualityRevision: input.qualityRevision,
    executionKind: input.job.executionKind, jobName: input.job.jobName, evidenceClass: input.job.evidenceClass, inputs: input.job.inputs });
}

function jobKey(job: { readonly executionKind: string; readonly jobName: string }): string {
  return `${job.executionKind}\0${job.jobName}`;
}
function domainDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update(JSON.stringify(canonicalValue(value))).digest("hex");
}
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) canonical[key] = canonicalValue(Reflect.get(value, key));
  return canonical;
}
function assertSortedUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length || values.some((value, index) => {
    const previous = values[index - 1]; return previous !== undefined && value <= previous;
  })) invalid("set ordering");
}
function invalid(part: string): never {
  throw new AuthoritativeNativeReviewSchemaError(`authoritative native ${part} is invalid`);
}
export class AuthoritativeNativeReviewSchemaError extends Error {
  readonly name = "AuthoritativeNativeReviewSchemaError";
}
