import { CodeReviewPolicyError } from "./policy.js";
import { createAuthoritativeNativeReview, AuthoritativeNativeReviewError } from "./authoritative-native-review.js";
import { readAuthoritativeNativeReviewEnvelopes } from "./authoritative-native-review-store.js";
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
  let body: z.infer<typeof resolveRequestSchema>;
  try {
    body = resolveRequestSchema.parse(await readBoundedJson(request));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) {
      return sendJson(response, 400, { error: "review resolution request is invalid" });
    }
    throw error;
  }
  await input.serialize(async () => {
    const runtime = { ...input.runtime, authoritativeTargetProofs: new Map() };
    const accept = (envelope: Awaited<ReturnType<typeof createAuthoritativeNativeReview>>) =>
      acceptReviewPreparations(runtime, envelope, `human:${reviewer.reviewerId}:${envelope.review.reviewId}`);
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
          });
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
        await accept(refreshed); return sendJson(response, 200, refreshed);
      }
      if (staleReasons.length !== 0) continue;
      if (envelope.review.requiredReviewerIds.length > 0
        && !envelope.review.requiredReviewerIds.includes(reviewer.reviewerId)) {
        return sendJson(response, 403, { error: "reviewer is not required for this review" });
      }
      await accept(envelope); return sendJson(response, 200, envelope);
    }
    try {
      const created = await createAuthoritativeNativeReview(runtime, {
        projectId,
        repositoryId,
        proposalRef: body.proposalRef,
        protectedRef: target.currentHead.protectedRef
      });
      if (created.review.requiredReviewerIds.length > 0
        && !created.review.requiredReviewerIds.includes(reviewer.reviewerId)) {
        return sendJson(response, 403, { error: "reviewer is not required for this review" });
      }
      await accept(created); return sendJson(response, 200, created);
    } catch (error) {
      if (error instanceof CodeReviewPolicyError) return sendJson(response, 409, { error: error.message });
      if (error instanceof AuthoritativeNativeReviewError) {
        return sendJson(response, 409, { error: "review candidate is unavailable" });
      }
      throw error;
    }
  });
}
