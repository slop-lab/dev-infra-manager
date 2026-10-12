import { z } from "zod";
import {
  createAuthoritativeOrdinaryAttemptStore,
  type CurrentAuthoritativeOrdinaryAttempt
} from "./authoritative-ordinary-attempt-store.js";
import {
  readCurrentAuthoritativeOrdinaryStatus,
  type CurrentAuthoritativeOrdinaryStatus
} from "./authoritative-ordinary-status-store.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";
import {
  resolveAuthoritativeNativeRootTarget,
  type AuthoritativeNativeCandidateRuntime,
  type AuthoritativeNativeRootTarget
} from "./authoritative-native-root-target.js";

const selectorSchema = z.object({
  projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  reviewId: z.string().regex(/^[0-9a-f]{64}$/),
  jobName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/)
}).strict().readonly();

export type CurrentOrdinaryTerminalSelector = z.infer<typeof selectorSchema>;

export type CurrentAuthoritativeOrdinaryTerminal = {
  readonly selector: CurrentOrdinaryTerminalSelector;
  readonly target: AuthoritativeNativeRootTarget;
  readonly envelope: AuthoritativeNativeReviewEnvelope;
  readonly attempt: CurrentAuthoritativeOrdinaryAttempt;
  readonly terminal: CurrentAuthoritativeOrdinaryStatus;
};

export async function currentAuthoritativeOrdinaryTerminal(
  runtime: AuthoritativeNativeCandidateRuntime,
  input: unknown,
  reporterUsername: string
): Promise<CurrentAuthoritativeOrdinaryTerminal> {
  const parsed = selectorSchema.safeParse(input);
  if (!parsed.success) throw new CurrentAuthoritativeOrdinaryTerminalError("ordinary terminal selector is invalid", {
    cause: parsed.error
  });
  const selector = parsed.data;
  const target = await resolveAuthoritativeNativeRootTarget(runtime, { projectId: selector.projectId });
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, selector.reviewId);
  if (envelope === undefined || envelope.review.projectId !== selector.projectId
    || envelope.review.repositoryId !== "root") {
    throw new CurrentAuthoritativeOrdinaryTerminalError("current ordinary review was not found");
  }
  const review = envelope.review;
  const required = envelope.planning.status === "valid" && envelope.planning.jobs.some((job) => job.executionKind === "ordinary-sysbox"
    && job.jobName === selector.jobName);
  if (!required || envelope.qualityRevision !== target.imported.policy.requiredJobSetRevision
    || (await nativeHumanReviewStaleReasons(runtime, target, review)).length > 0) {
    throw new CurrentAuthoritativeOrdinaryTerminalError("current ordinary review is stale");
  }
  const attempt = await createAuthoritativeOrdinaryAttemptStore(target.repository)
    .current(selector.reviewId, selector.jobName);
  if (attempt === undefined || attempt.revocation !== undefined || !descriptorMatchesReview(attempt, envelope)) {
    throw new CurrentAuthoritativeOrdinaryTerminalError("current ordinary attempt was not found");
  }
  const terminal = await readCurrentAuthoritativeOrdinaryStatus(target.repository, attempt, reporterUsername);
  if (terminal === undefined) {
    throw new CurrentAuthoritativeOrdinaryTerminalError("current ordinary terminal status was not found");
  }
  return { selector, target, envelope, attempt, terminal };
}

function descriptorMatchesReview(
  current: CurrentAuthoritativeOrdinaryAttempt,
  envelope: AuthoritativeNativeReviewEnvelope
): boolean {
  const descriptor = current.attempt.descriptor;
  const review = envelope.review;
  return descriptor.projectId === review.projectId && descriptor.repositoryId === review.repositoryId
    && descriptor.protectedRef === review.protectedRef
    && descriptor.expectedProtectedHead === review.expectedProtectedHead
    && descriptor.candidateCommit === review.candidateCommit && descriptor.candidateTree === review.candidateTree
    && descriptor.policyRevision === review.policyRevision
    && descriptor.requiredReviewRevision === review.requiredReviewRevision
    && descriptor.requiredJobSetRevision === envelope.qualityRevision;
}

export class CurrentAuthoritativeOrdinaryTerminalError extends Error {
  readonly name = "CurrentAuthoritativeOrdinaryTerminalError";
}
