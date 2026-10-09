import { loadAuthoritativeNativeCandidateJobInputs } from "./authoritative-native-candidate-job-inputs.js";
import type { NativeCandidateJobInputs } from "./native-candidate-job-inputs.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRootTarget } from "./authoritative-native-root-target.js";
import { CandidateExecutionError } from "./candidate-execution-schema.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";

type Target = Awaited<ReturnType<typeof resolveAuthoritativeNativeRootTarget>>;
type Envelope = NonNullable<Awaited<ReturnType<typeof readAuthoritativeNativeReviewEnvelope>>>;

export type AuthoritativeExecutionReviewSnapshot = {
  readonly target: Target;
  readonly envelope: Envelope;
};

export type CurrentAuthoritativeExecutionInputs = {
  readonly inputs: NativeCandidateJobInputs;
  readonly review: Envelope["review"];
};

export async function loadAuthoritativeExecutionReview(
  runtime: AuthoritativeNativeCandidateRuntime,
  selector: { readonly projectId: string; readonly reviewId: string }
): Promise<AuthoritativeExecutionReviewSnapshot> {
  const target = await resolveAuthoritativeNativeRootTarget(runtime, { projectId: selector.projectId });
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, selector.reviewId);
  if (envelope === undefined || envelope.review.projectId !== selector.projectId
    || envelope.review.repositoryId !== "root") {
    throw new CandidateExecutionError("authoritative execution review was not found");
  }
  await assertCurrentReview(runtime, target, envelope.review);
  return { target, envelope };
}

export async function loadCurrentAuthoritativeExecutionInputs(
  runtime: AuthoritativeNativeCandidateRuntime,
  snapshot: AuthoritativeExecutionReviewSnapshot
): Promise<CurrentAuthoritativeExecutionInputs> {
  const inputs = await loadAuthoritativeNativeCandidateJobInputs(runtime, {
    projectId: snapshot.envelope.review.projectId,
    candidateCommit: snapshot.envelope.review.candidateCommit,
    candidateTree: snapshot.envelope.review.candidateTree
  });
  const currentTarget = await resolveAuthoritativeNativeRootTarget(runtime, {
    projectId: snapshot.envelope.review.projectId
  });
  const currentEnvelope = await readAuthoritativeNativeReviewEnvelope(
    currentTarget.repository,
    snapshot.envelope.review.reviewId
  );
  if (currentEnvelope === undefined || JSON.stringify(currentEnvelope) !== JSON.stringify(snapshot.envelope)
    || JSON.stringify(currentTarget) !== JSON.stringify(snapshot.target)) {
    throw new CandidateExecutionError("authoritative execution review changed during candidate read");
  }
  await assertCurrentReview(runtime, currentTarget, currentEnvelope.review);
  return { inputs, review: currentEnvelope.review };
}

async function assertCurrentReview(
  runtime: AuthoritativeNativeCandidateRuntime,
  target: Target,
  review: Envelope["review"]
): Promise<void> {
  const staleReasons = await nativeHumanReviewStaleReasons(runtime, target, review);
  if (staleReasons.length > 0) {
    throw new CandidateExecutionError("authoritative execution review is stale");
  }
}
