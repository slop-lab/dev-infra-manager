import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { AuthoritativeNativeApprovalConflictError } from "./authoritative-native-approval-store.js";
import {
  approveAuthoritativeNativeReview,
  AuthoritativeNativeDecisionForbiddenError,
  AuthoritativeNativeDecisionNotFoundError,
  readAuthoritativeNativeDecisions,
  revokeAuthoritativeNativeApproval
} from "./authoritative-native-decision-store.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";
import { nativeHumanReviewStatus } from "./native-human-reviewer-status.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRootTarget } from "./authoritative-native-root-target.js";
import { exactActivationIsBound } from "./native-bundle-activation.js";
import { NativeGitBundleHttpError, readBoundedJson, sendJson, sendNotFound } from "./native-bundle-http.js";
import { readNativeProjectRegistrations } from "./native-bundle-state.js";

type Credential = { readonly username: string; readonly password: string };
type HumanReviewer = NativeGitBundleConfig["humanReviewers"][number];
type HumanReviewerHttpInput = {
  readonly config: NativeGitBundleConfig;
  readonly hooks?: NativeHumanReviewerHooks;
  readonly knownCredentials: readonly Credential[];
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
};

export type NativeHumanReviewerHooks = { readonly beforeApprovalPublication?: () => void | Promise<void> };
const approvalRequestSchema = z.object({ requestId: z.string().uuid() }).strict().readonly();
const revocationRequestSchema = z.object({ approvalId: z.string().regex(/^[0-9a-f]{64}$/) }).strict().readonly();

export type NativeHumanReviewerService = {
  readonly handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
};

export function createNativeHumanReviewerService(input: HumanReviewerHttpInput): NativeHumanReviewerService {
  return {
    async handle(request, response, url) {
      const identity = request.method === "GET" && url.pathname === "/v1/human-reviewer-identity"
        && url.search === "";
      const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/root\/reviews\/([0-9a-f]{64})(\/(?:approvals|revocations))?$/
        .exec(url.pathname);
      const review = request.method === "GET" && url.search === "" && match !== null && match[3] === undefined;
      const approval = request.method === "POST" && url.search === "" && match?.[3] === "/approvals";
      const revocation = request.method === "POST" && url.search === "" && match?.[3] === "/revocations";
      if (!identity && !review && !approval && !revocation) return false;
      const reviewer = input.config.humanReviewers.find((candidate) => basicAuthorized(request, candidate));
      if (reviewer === undefined) {
        const known = input.knownCredentials.some((credential) => basicAuthorized(request, credential));
        sendJson(response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
        return true;
      }
      if (identity) {
        sendJson(response, 200, {
          schemaVersion: 1,
          serviceId: "native-main",
          role: "human-reviewer",
          reviewerId: reviewer.reviewerId,
          generationId: input.runtime.expectedGenerationId
        });
        return true;
      }
      const projectId = match?.[1];
      const reviewId = match?.[2];
      if (projectId === undefined || reviewId === undefined) return false;
      if (approval) await approveExactReview(input, reviewer, projectId, reviewId, request, response);
      else if (revocation) await revokeExactApproval(input, reviewer, projectId, reviewId, request, response);
      else await serveExactReview(input, reviewer, projectId, reviewId, request, response);
      return true;
    }
  };
}

async function serveExactReview(
  input: HumanReviewerHttpInput,
  reviewer: HumanReviewer,
  projectId: string,
  reviewId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const selected = await inspectExactReview(input, reviewer, projectId, reviewId, request, response);
  if (selected === undefined) return;
  const decisions = await readAuthoritativeNativeDecisions(selected.target.repository, reviewId);
  sendJson(response, 200, {
    status: nativeHumanReviewStatus(selected.envelope.review.requiredReviewerIds, selected.staleReasons, decisions),
    staleReasons: selected.staleReasons,
    ...selected.envelope,
    approvals: decisions.approvals,
    revocations: decisions.revocations
  });
}

async function approveExactReview(
  input: HumanReviewerHttpInput,
  reviewer: HumanReviewer,
  projectId: string,
  reviewId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
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
    const result = await input.serialize(async () => {
      const selected = await inspectExactReview(input, reviewer, projectId, reviewId, request, response);
      if (selected === undefined || response.writableEnded) return undefined;
      if (selected.staleReasons.length > 0) {
        sendJson(response, 409, { error: "review is stale" });
        return undefined;
      }
      await input.hooks?.beforeApprovalPublication?.();
      const saved = await approveAuthoritativeNativeReview({
        repository: selected.target.repository,
        reviewId,
        reviewerId: reviewer.reviewerId,
        requestId: body.requestId
      });
      const confirmed = await inspectExactReview(input, reviewer, projectId, reviewId, request, response);
      if (confirmed === undefined || response.writableEnded) return undefined;
      const decisions = await readAuthoritativeNativeDecisions(confirmed.target.repository, reviewId);
      return { ...saved, status: nativeHumanReviewStatus(
        confirmed.envelope.review.requiredReviewerIds, confirmed.staleReasons, decisions),
        staleReasons: confirmed.staleReasons };
    });
    if (result !== undefined) sendJson(response, result.created ? 201 : 200,
      { ...result.approval, status: result.status, staleReasons: result.staleReasons });
  } catch (error) {
    if (error instanceof AuthoritativeNativeApprovalConflictError) {
      return sendJson(response, 409, { error: error.message });
    }
    throw error;
  }
}

async function revokeExactApproval(input: HumanReviewerHttpInput, reviewer: HumanReviewer, projectId: string,
  reviewId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
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
    const result = await input.serialize(async () => {
      const selected = await inspectExactReview(input, reviewer, projectId, reviewId, request, response);
      if (selected === undefined || response.writableEnded) return undefined;
      const saved = await revokeAuthoritativeNativeApproval({ repository: selected.target.repository, reviewId,
        reviewerId: reviewer.reviewerId, approvalId: body.approvalId });
      const decisions = await readAuthoritativeNativeDecisions(selected.target.repository, reviewId);
      return { ...saved, status: nativeHumanReviewStatus(
        selected.envelope.review.requiredReviewerIds, selected.staleReasons, decisions),
        staleReasons: selected.staleReasons };
    });
    if (result !== undefined) sendJson(response, result.created ? 201 : 200,
      { ...result.revocation, status: result.status, staleReasons: result.staleReasons });
  } catch (error) {
    if (error instanceof AuthoritativeNativeDecisionNotFoundError) return sendNotFound(response);
    if (error instanceof AuthoritativeNativeDecisionForbiddenError) {
      return sendJson(response, 403, { error: error.message });
    }
    throw error;
  }
}

type ExactReview = {
  readonly target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRootTarget>>;
  readonly envelope: NonNullable<Awaited<ReturnType<typeof readAuthoritativeNativeReviewEnvelope>>>;
  readonly staleReasons: readonly string[];
};

async function inspectExactReview(
  input: HumanReviewerHttpInput,
  reviewer: HumanReviewer,
  projectId: string,
  reviewId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<ExactReview | undefined> {
  if (!readNativeProjectRegistrations(input.runtime.state).some((entry) => entry.projectId === projectId)) {
    sendNotFound(response);
    return undefined;
  }
  if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) {
    sendJson(response, 409, { error: "review generation conflicts with service startup" });
    return undefined;
  }
  if (!input.runtime.activated() || !exactActivationIsBound(
    input.runtime.state,
    input.runtime.expectedGenerationId,
    input.runtime.activationTokenDigest
  )) {
    sendJson(response, 503, { error: "human review proof is unavailable" });
    return undefined;
  }
  let target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRootTarget>>;
  try {
    target = await resolveAuthoritativeNativeRootTarget(input.runtime, { projectId });
  } catch (error) {
    if (error instanceof Error) {
      sendJson(response, 503, { error: "human review proof is unavailable" });
      return undefined;
    }
    throw error;
  }
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, reviewId);
  if (envelope === undefined || envelope.review.projectId !== projectId || envelope.review.repositoryId !== "root") {
    sendNotFound(response);
    return undefined;
  }
  if (!envelope.review.requiredReviewerIds.includes(reviewer.reviewerId)) {
    sendJson(response, 403, { error: "reviewer is not required for this review" });
    return undefined;
  }
  const staleReasons = await nativeHumanReviewStaleReasons(input.runtime, target, envelope.review);
  try {
    const confirmed = await resolveAuthoritativeNativeRootTarget(input.runtime, { projectId });
    if (JSON.stringify(confirmed) !== JSON.stringify(target)) {
      sendJson(response, 503, { error: "human review proof is unavailable" });
      return undefined;
    }
  } catch (error) {
    if (error instanceof Error) {
      sendJson(response, 503, { error: "human review proof is unavailable" });
      return undefined;
    }
    throw error;
  }
  return { target, envelope, staleReasons: [...new Set(staleReasons)] };
}

function basicAuthorized(request: IncomingMessage, credential: Credential): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
