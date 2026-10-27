import { AuthoritativeNativeApprovalConflictError } from "./authoritative-native-approval-store.js";
import {
  approveAuthoritativeNativeReview,
  AuthoritativeNativeDecisionForbiddenError,
  AuthoritativeNativeDecisionNotFoundError,
  readAuthoritativeNativeDecisions,
  revokeAuthoritativeNativeApproval
} from "./authoritative-native-decision-store.js";
import type { ExactReviewRoute, HumanReviewerRequestContext } from "./native-human-reviewer-http-types.js";
import { inspectExactReview } from "./native-human-reviewer-read.js";
import { nativeHumanReviewStatus } from "./native-human-reviewer-status.js";
import {
  NativeGitBundleHttpError,
  readBoundedJson,
  sendJson,
  sendNotFound
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { z } from "zod";

const approvalRequestSchema = z.object({ requestId: z.string().uuid() }).strict().readonly();
const revocationRequestSchema = z.object({ approvalId: z.string().regex(/^[0-9a-f]{64}$/) }).strict().readonly();

export async function approveExactReview(
  context: HumanReviewerRequestContext,
  route: ExactReviewRoute
): Promise<void> {
  const { input, request, response, reviewer } = context;
  let body: z.infer<typeof approvalRequestSchema>;
  try {
    body = approvalRequestSchema.parse(await readBoundedJson(request));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) {
      return sendJson(response, 400, { error: "approval request is invalid" });
    }
    throw error;
  }
  try {
    const saved = await input.mutate({ projectId: route.projectId, repositoryId: route.repositoryId }, async () => {
      const selected = await inspectExactReview(context, route);
      if (selected === undefined || response.writableEnded) return undefined;
      if (!selected.envelope.review.requiredReviewerIds.includes(reviewer.reviewerId)) {
        sendJson(response, 403, { error: "reviewer is not required for this review" });
        return undefined;
      }
      if (selected.staleReasons.length > 0) {
        sendJson(response, 409, { error: "review is stale" });
        return undefined;
      }
      await input.hooks?.beforeApprovalPublication?.();
      return approveAuthoritativeNativeReview({
        repository: selected.target.repository,
        reviewId: route.reviewId,
        reviewerId: reviewer.reviewerId,
        requestId: body.requestId
      });
    });
    if (saved !== undefined) {
      await input.read(async () => {
        const confirmed = await inspectExactReview(context, route);
        if (confirmed === undefined || response.writableEnded) return;
        const decisions = await readAuthoritativeNativeDecisions(confirmed.target.repository, route.reviewId);
        sendJson(response, saved.created ? 201 : 200, {
          ...saved.approval,
          status: nativeHumanReviewStatus(confirmed.envelope.review.requiredReviewerIds, confirmed.staleReasons, decisions),
          staleReasons: confirmed.staleReasons
        });
      });
    }
  } catch (error) {
    if (error instanceof AuthoritativeNativeApprovalConflictError) {
      return sendJson(response, 409, { error: error.message });
    }
    throw error;
  }
}

export async function revokeExactApproval(
  context: HumanReviewerRequestContext,
  route: ExactReviewRoute
): Promise<void> {
  const { input, request, response, reviewer } = context;
  let body: z.infer<typeof revocationRequestSchema>;
  try {
    body = revocationRequestSchema.parse(await readBoundedJson(request));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) {
      return sendJson(response, 400, { error: "revocation request is invalid" });
    }
    throw error;
  }
  try {
    const saved = await input.mutate({ projectId: route.projectId, repositoryId: route.repositoryId }, async () => {
      const selected = await inspectExactReview(context, route);
      if (selected === undefined || response.writableEnded) return undefined;
      return revokeAuthoritativeNativeApproval({
        repository: selected.target.repository,
        reviewId: route.reviewId,
        reviewerId: reviewer.reviewerId,
        approvalId: body.approvalId
      });
    });
    if (saved !== undefined) {
      await input.read(async () => {
        const confirmed = await inspectExactReview(context, route);
        if (confirmed === undefined || response.writableEnded) return;
        const decisions = await readAuthoritativeNativeDecisions(confirmed.target.repository, route.reviewId);
        sendJson(response, saved.created ? 201 : 200, {
          ...saved.revocation,
          status: nativeHumanReviewStatus(confirmed.envelope.review.requiredReviewerIds, confirmed.staleReasons, decisions),
          staleReasons: confirmed.staleReasons
        });
      });
    }
  } catch (error) {
    if (error instanceof AuthoritativeNativeDecisionNotFoundError) return sendNotFound(response);
    if (error instanceof AuthoritativeNativeDecisionForbiddenError) {
      return sendJson(response, 403, { error: error.message });
    }
    throw error;
  }
}
