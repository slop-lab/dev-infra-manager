import type { GitCiRuntime } from "./runtime.js";
import { loadAuthoritativeNativeCandidateJobInputs } from "./authoritative-native-candidate-job-inputs.js";
import type { NativeCandidateJobInputs } from "./native-candidate-job-inputs.js";
import { readAuthoritativeNativeReviewEnvelope } from "./plan-store.js";

import { resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { CandidateExecutionError } from "@slop-lab/dim-contracts-ci/descriptor";
import { nativeHumanReviewStaleReasons } from "@slop-lab/dim-control-plane-plugin-code-review/plugin-api";

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
  runtime: GitCiRuntime,
  selector: { readonly projectId: string; readonly repositoryId: string; readonly reviewId: string }
): Promise<AuthoritativeExecutionReviewSnapshot> {
  const initial = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: selector.projectId, repositoryId: selector.repositoryId });
  const envelope = await readAuthoritativeNativeReviewEnvelope(initial.repository, selector.reviewId);
  if (envelope === undefined || envelope.review.projectId !== selector.projectId
    || envelope.review.repositoryId !== selector.repositoryId) {
    throw new CandidateExecutionError("authoritative execution review was not found");
  }
  const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: selector.projectId, repositoryId: selector.repositoryId, protectedRef: envelope.review.protectedRef });
  await assertCurrentReview(runtime, target, envelope.review);
  return { target, envelope };
}

export async function loadCurrentAuthoritativeExecutionInputs(
  runtime: GitCiRuntime,
  snapshot: AuthoritativeExecutionReviewSnapshot
): Promise<CurrentAuthoritativeExecutionInputs> {
  const inputs = await loadAuthoritativeNativeCandidateJobInputs(runtime, {
    projectId: snapshot.envelope.review.projectId, repositoryId: snapshot.envelope.review.repositoryId, protectedRef: snapshot.envelope.review.protectedRef,
    candidateCommit: snapshot.envelope.review.candidateCommit,
    candidateTree: snapshot.envelope.review.candidateTree
  });
  const currentTarget = await resolveAuthoritativeNativeRepositoryTarget(runtime, {
    projectId: snapshot.envelope.review.projectId, repositoryId: snapshot.envelope.review.repositoryId, protectedRef: snapshot.envelope.review.protectedRef
  });
  const currentEnvelope = await readAuthoritativeNativeReviewEnvelope(
    currentTarget.repository,
    snapshot.envelope.review.reviewId
  );
  if (currentEnvelope === undefined || JSON.stringify(currentEnvelope) !== JSON.stringify(snapshot.envelope)
    || !sameSelectedTarget(currentTarget, snapshot.target)) {
    throw new CandidateExecutionError("authoritative execution review changed during candidate read");
  }
  await assertCurrentReview(runtime, currentTarget, currentEnvelope.review);
  return { inputs, review: currentEnvelope.review };
}

async function assertCurrentReview(
  runtime: GitCiRuntime,
  target: Target,
  review: Envelope["review"]
): Promise<void> {
  const staleReasons = await nativeHumanReviewStaleReasons(runtime, target, review);
  if (staleReasons.length > 0) {
    throw new CandidateExecutionError("authoritative execution review is stale");
  }
}

/** The repository sequence serializes all branches; another branch moving does not invalidate this snapshot. */
function sameSelectedTarget(left: Target, right: Target): boolean {
  const { sequence: _leftSequence, ...leftHead } = left.currentHead;
  const { sequence: _rightSequence, ...rightHead } = right.currentHead;
  return left.repository === right.repository && JSON.stringify(left.imported) === JSON.stringify(right.imported)
    && JSON.stringify(leftHead) === JSON.stringify(rightHead);
}
