import { loadAuthoritativeNativeCandidateJobInputs } from "./authoritative-native-candidate-job-inputs.js";
import type { NativeCandidateJobInputs } from "./native-candidate-job-inputs.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRepositoryTarget } from "./authoritative-native-root-target.js";
import { CandidateExecutionError } from "@slop-lab/dim-contracts-ci/descriptor";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";

type Target = Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
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
  selector: { readonly projectId: string; readonly repositoryId: string; readonly reviewId: string }
): Promise<AuthoritativeExecutionReviewSnapshot> {
  const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: selector.projectId, repositoryId: selector.repositoryId });
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, selector.reviewId);
  if (envelope === undefined || envelope.review.projectId !== selector.projectId
    || envelope.review.repositoryId !== selector.repositoryId) {
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
    projectId: snapshot.envelope.review.projectId, repositoryId: snapshot.envelope.review.repositoryId,
    candidateCommit: snapshot.envelope.review.candidateCommit,
    candidateTree: snapshot.envelope.review.candidateTree
  });
  const currentTarget = await resolveAuthoritativeNativeRepositoryTarget(runtime, {
    projectId: snapshot.envelope.review.projectId, repositoryId: snapshot.envelope.review.repositoryId
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
