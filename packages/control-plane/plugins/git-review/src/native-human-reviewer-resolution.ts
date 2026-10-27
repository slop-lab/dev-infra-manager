import { CodeReviewPolicyError } from "./policy.js";
import { createAuthoritativeNativeReview, AuthoritativeNativeReviewError, type AuthoritativeNativeReviewHooks } from "./authoritative-native-review.js";
import { dirname, join } from "node:path";
import { readAuthoritativeNativeReviewEnvelope, readAuthoritativeNativeReviewEnvelopes } from "./authoritative-native-review-store.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";
import type { HumanReviewerRequestContext, RepositoryReviewRoute } from "./native-human-reviewer-http-types.js";
import {
  exactActivationIsBound,
  NativeGitBundleHttpError,
  readBoundedJson,
  resolveAuthoritativeNativeRepositoryTarget,
  sendJson
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { z } from "zod";
import { acceptReviewPreparations } from "./plugin-api.js";
import { completeProposalAcceptance, failProposalAcceptance, hasPendingProposalAcceptance, stageProposalAcceptance } from "./proposal-acceptance.js";
import { completeMatchingRawProposalJob } from "./raw-proposal-journal.js";

const resolveRequestSchema = z.object({
  schemaVersion: z.literal(1),
  protectedRef: z.string().startsWith("refs/heads/").optional(),
  proposalRef: z.string().min(1).max(1024)
}).strict().readonly();

export async function resolveCurrentEnvelope(
  context: HumanReviewerRequestContext,
  route: RepositoryReviewRoute
): Promise<void> {
  const { input, request, response, reviewer } = context;
  const { projectId, repositoryId } = route;
  const repository = join(dirname(input.runtime.state.database), projectId, `${repositoryId}.git`);
  const acceptanceHooks: AuthoritativeNativeReviewHooks = { beforePublication: ({ repository, envelope }) =>
    stageProposalAcceptance(repository, input.runtime.expectedGenerationId, envelope) };
  let body: z.infer<typeof resolveRequestSchema>;
  try {
    body = resolveRequestSchema.parse(await readBoundedJson(request));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) {
      return sendJson(response, 400, { error: "review resolution request is invalid" });
    }
    throw error;
  }
  const envelope = await input.mutate({ projectId, repositoryId }, async () => {
    const runtime = { ...input.runtime, authoritativeTargetProofs: new Map() };
    if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) {
      return sendJson(response, 409, { error: "review generation conflicts with service startup" });
    }
    if (!input.runtime.activated() || !exactActivationIsBound(
      input.runtime.state, input.runtime.expectedGenerationId, input.runtime.activationTokenDigest
    )) return sendJson(response, 503, { error: "human review proof is unavailable" });
    let target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
    try {
      target = await resolveAuthoritativeNativeRepositoryTarget(runtime, {
        projectId,
        repositoryId,
        ...(body.protectedRef === undefined ? {} : { protectedRef: body.protectedRef })
      });
    } catch (error) {
      if (error instanceof Error) return sendJson(response, 404, { error: "not found" });
      throw error;
    }
    const envelopes = (await readAuthoritativeNativeReviewEnvelopes(target.repository))
      .filter((envelope) => envelope.review.projectId === projectId && envelope.review.repositoryId === repositoryId
        && envelope.review.proposalRef === body.proposalRef
        && envelope.review.protectedRef === target.currentHead.protectedRef
        && envelope.policyDigest === target.imported.policyDigest)
      .sort((left, right) => right.review.createdAt.localeCompare(left.review.createdAt));
    for (const envelope of envelopes) {
      const staleReasons = await nativeHumanReviewStaleReasons(runtime, target, envelope.review);
      if (staleReasons.includes("repository-inputs-changed")) {
        let refreshed;
        try {
          refreshed = await createAuthoritativeNativeReview(runtime, {
            projectId,
            repositoryId,
            proposalRef: body.proposalRef,
            protectedRef: target.currentHead.protectedRef
          }, acceptanceHooks);
        } catch (error) {
          if (error instanceof CodeReviewPolicyError) return sendJson(response, 409, { error: error.message });
          if (error instanceof AuthoritativeNativeReviewError) {
            return sendJson(response, 409, { error: "review input snapshot is unavailable" });
          }
          throw error;
        }
        if (refreshed.review.requiredReviewerIds.length > 0
          && !refreshed.review.requiredReviewerIds.includes(reviewer.reviewerId)) {
          return sendJson(response, 403, { error: "reviewer is not required for this review" });
        }
        return refreshed;
      }
      if (staleReasons.length !== 0) continue;
      if (envelope.review.requiredReviewerIds.length > 0
        && !envelope.review.requiredReviewerIds.includes(reviewer.reviewerId)) {
        return sendJson(response, 403, { error: "reviewer is not required for this review" });
      }
      await stageProposalAcceptance(repository, input.runtime.expectedGenerationId, envelope);
      return envelope;
    }
    try {
      const created = await createAuthoritativeNativeReview(runtime, {
        projectId,
        repositoryId,
        proposalRef: body.proposalRef,
        protectedRef: target.currentHead.protectedRef
      }, acceptanceHooks);
      if (created.review.requiredReviewerIds.length > 0
        && !created.review.requiredReviewerIds.includes(reviewer.reviewerId)) {
        return sendJson(response, 403, { error: "reviewer is not required for this review" });
      }
      return created;
    } catch (error) {
      if (error instanceof CodeReviewPolicyError) return sendJson(response, 409, { error: error.message });
      if (error instanceof AuthoritativeNativeReviewError) {
        return sendJson(response, 409, { error: "review candidate is unavailable" });
      }
      throw error;
    }
  });
  if (envelope === undefined || response.writableEnded) return;
  try {
    await acceptReviewPreparations(input.runtime, envelope, `human:${reviewer.reviewerId}:${envelope.review.reviewId}`);
  } catch (error) {
    await failProposalAcceptance(repository, input.runtime.expectedGenerationId, envelope);
    throw error;
  }
  const completed = await input.mutate({ projectId, repositoryId }, async () => {
    if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId
      || !input.runtime.activated() || !exactActivationIsBound(
        input.runtime.state, input.runtime.expectedGenerationId, input.runtime.activationTokenDigest
      )) {
      sendJson(response, 409, { error: "review changed while acceptance completed" });
      return false;
    }
    const runtime = { ...input.runtime, authoritativeTargetProofs: new Map() };
    let target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
    try {
      target = await resolveAuthoritativeNativeRepositoryTarget(runtime, {
        projectId, repositoryId, protectedRef: envelope.review.protectedRef
      });
    } catch (error) {
      if (error instanceof Error) {
        sendJson(response, 409, { error: "review changed while acceptance completed" });
        return false;
      }
      throw error;
    }
    const stored = await readAuthoritativeNativeReviewEnvelope(target.repository, envelope.review.reviewId);
    if (stored?.envelopeId !== envelope.envelopeId || envelope.policyDigest !== target.imported.policyDigest
      || (await nativeHumanReviewStaleReasons(runtime, target, envelope.review)).length > 0) {
      sendJson(response, 409, { error: "review changed while acceptance completed" });
      return false;
    }
    for (const preparation of runtime.reviewPreparations ?? []) {
      const attachment = envelope.attachments.find(({ kind }) => kind === preparation.name);
      try {
        await preparation.assertCurrent?.({ runtime, review: envelope.review,
          ...(attachment === undefined ? {} : { attachment }) });
      } catch (error) {
        if (error instanceof Error) {
          sendJson(response, 409, { error: "review changed while acceptance completed" });
          return false;
        }
        throw error;
      }
    }
    if (await hasPendingProposalAcceptance(target.repository, input.runtime.expectedGenerationId, envelope)) {
      await completeProposalAcceptance(target.repository, input.runtime.expectedGenerationId, envelope);
    }
    await completeMatchingRawProposalJob(target.repository, input.runtime.expectedGenerationId, envelope);
    return true;
  });
  if (completed) sendJson(response, 200, envelope);
}
