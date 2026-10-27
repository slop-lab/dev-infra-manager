import { policyReviewerIds } from "./native-human-reviewer-policy.js";
import { readRawProposalJobs } from "./raw-proposal-journal.js";
import type { HumanReviewerRequestContext, RepositoryReviewRoute } from "./native-human-reviewer-http-types.js";
import {
  exactActivationIsBound,
  assertAuthoritativeNativeRepositoryTargetCurrent,
  readNativeProjectRegistrations,
  resolveAuthoritativeNativeRepositoryTarget,
  sendJson,
  sendNotFound
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";

export async function serveRawProposalJobs(
  context: HumanReviewerRequestContext,
  route: RepositoryReviewRoute
): Promise<void> {
  const { input, request, response, reviewer } = context;
  await input.read(async () => {
    if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) {
      return sendJson(response, 409, { error: "review generation is stale" });
    }
    if (!input.runtime.activated() || !exactActivationIsBound(
      input.runtime.state, input.runtime.expectedGenerationId, input.runtime.activationTokenDigest
    )) return sendJson(response, 503, { error: "human review is unavailable" });
    if (!readNativeProjectRegistrations(input.runtime.state)
      .some((entry) => entry.projectId === route.projectId && entry.repositoryId === route.repositoryId)) return sendNotFound(response);
    let target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
    try {
      target = await resolveAuthoritativeNativeRepositoryTarget({ ...input.runtime, authoritativeTargetProofs: new Map() }, route);
    } catch {
      return sendNotFound(response);
    }
    if (!policyReviewerIds(target.imported.policy, input.runtime.reviewChangeMatchers).has(reviewer.reviewerId)) {
      return sendJson(response, 403, { error: "forbidden" });
    }
    const jobs = (await readRawProposalJobs(target.repository))
      .filter(({ binding }) => binding.projectId === route.projectId && binding.repositoryId === route.repositoryId)
      .map(({ jobId, capturedAt, binding, state }) => ({
        jobId, capturedAt, generationId: binding.generationId, projectId: binding.projectId,
        repositoryId: binding.repositoryId, proposalRef: binding.proposalRef, protectedRef: binding.protectedRef,
        expectedProtectedHead: binding.expectedProtectedHead, candidateCommit: binding.candidateCommit,
        candidateTree: binding.candidateTree, policyDigest: binding.policyDigest, ...state
       }));
    await assertAuthoritativeNativeRepositoryTargetCurrent({ runtime: { ...input.runtime, authoritativeTargetProofs: new Map() },
      selector: route, target });
    sendJson(response, 200, { schemaVersion: 1, jobs });
  });
}
