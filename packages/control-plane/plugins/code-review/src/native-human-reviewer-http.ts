import { createAuthoritativeNativeReview, AuthoritativeNativeReviewError } from "./authoritative-native-review.js";
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
import type { CodeReviewConfig } from "./config.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";
import { nativeHumanReviewStatus } from "./native-human-reviewer-status.js";
import {
  readAuthoritativeNativeReviewEnvelope,
  readAuthoritativeNativeReviewEnvelopes
} from "./authoritative-native-review-store.js";
import type { CodeReviewRuntime as AuthoritativeNativeCandidateRuntime } from "./plugin-api.js";
import { resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { exactActivationIsBound } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { NativeGitBundleHttpError, readBoundedJson, sendJson, sendNotFound } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { readNativeProjectRegistrations } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { nativeRepositoryBranches } from "@slop-lab/dim-contracts-git";

type Credential = { readonly username: string; readonly password: string };
type HumanReviewer = CodeReviewConfig["humanReviewers"][number];
type HumanReviewerHttpInput = {
  readonly config: CodeReviewConfig;
  readonly hooks?: NativeHumanReviewerHooks;
  readonly knownCredentials: readonly Credential[];
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
};

export type NativeHumanReviewerHooks = { readonly beforeApprovalPublication?: () => void | Promise<void> };
const approvalRequestSchema = z.object({ requestId: z.string().uuid() }).strict().readonly();
const revocationRequestSchema = z.object({ approvalId: z.string().regex(/^[0-9a-f]{64}$/) }).strict().readonly();
const resolveRequestSchema = z.object({
  schemaVersion: z.literal(1),
  protectedRef: z.string().startsWith("refs/heads/").optional(),
  proposalRef: z.string().min(1).max(1024)
}).strict().readonly();

export type NativeHumanReviewerService = {
  readonly handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
};

export function createNativeHumanReviewerService(input: HumanReviewerHttpInput): NativeHumanReviewerService {
  return {
    async handle(request, response, url) {
      const identity = request.method === "GET" && url.pathname === "/v1/human-reviewer-identity"
        && url.search === "";
      const listing = request.method === "GET" && url.search === "" ? /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/reviews$/.exec(url.pathname) : null;
      const resolve = request.method === "POST" && url.search === ""
        && /^\/v1\/projects\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/reviews\/resolve$/
          .test(url.pathname);
      const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/reviews\/([0-9a-f]{64})(\/(?:approvals|revocations))?$/
        .exec(url.pathname);
      const review = request.method === "GET" && url.search === "" && match !== null && match[4] === undefined;
      const approval = request.method === "POST" && url.search === "" && match?.[4] === "/approvals";
      const revocation = request.method === "POST" && url.search === "" && match?.[4] === "/revocations";
      if (!identity && listing === null && !resolve && !review && !approval && !revocation) return false;
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
      if (listing?.[1] !== undefined) {
        await listReviewSummaries(input, reviewer, listing[1], listing[2]!, request, response);
        return true;
      }
      if (resolve) {
        const projectId = url.pathname.split("/")[3];
        const repositoryId = url.pathname.split("/")[5];
        if (projectId === undefined || repositoryId === undefined) return false;
        await resolveCurrentEnvelope(input, reviewer, projectId, repositoryId, request, response);
        return true;
      }
      const projectId = match?.[1];
      const repositoryId = match?.[2];
      const reviewId = match?.[3];
      if (projectId === undefined || repositoryId === undefined || reviewId === undefined) return false;
      if (approval) await approveExactReview(input, reviewer, projectId, repositoryId, reviewId, request, response);
      else if (revocation) await revokeExactApproval(input, reviewer, projectId, repositoryId, reviewId, request, response);
      else await serveExactReview(input, reviewer, projectId, repositoryId, reviewId, request, response);
      return true;
    }
  };
}

async function resolveCurrentEnvelope(
  input: HumanReviewerHttpInput,
  reviewer: HumanReviewer,
  projectId: string,
  repositoryId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
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
    if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) {
      return sendJson(response, 409, { error: "review generation conflicts with service startup" });
    }
    if (!input.runtime.activated() || !exactActivationIsBound(
      input.runtime.state, input.runtime.expectedGenerationId, input.runtime.activationTokenDigest
    )) return sendJson(response, 503, { error: "human review proof is unavailable" });
    let target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
    try {
      target = await resolveAuthoritativeNativeRepositoryTarget(input.runtime, { projectId, repositoryId, ...(body.protectedRef === undefined ? {} : { protectedRef: body.protectedRef }) });
    } catch (error) {
      if (error instanceof Error) return sendJson(response, 404, { error: "not found" });
      throw error;
    }
    const envelopes = (await readAuthoritativeNativeReviewEnvelopes(target.repository))
      .filter((envelope) => envelope.review.projectId === projectId && envelope.review.repositoryId === repositoryId
        && envelope.review.proposalRef === body.proposalRef
        && envelope.review.protectedRef === target.currentHead.protectedRef
        && envelope.policyDigest === target.imported.policyDigest
)
      .sort((left, right) => right.review.createdAt.localeCompare(left.review.createdAt));
    for (const envelope of envelopes) {
      if (envelope.review.requiredReviewerIds.length > 0 && !envelope.review.requiredReviewerIds.includes(reviewer.reviewerId)) return sendJson(response, 403, { error: "reviewer is not required for this review" });
      const staleReasons = await nativeHumanReviewStaleReasons(input.runtime, target, envelope.review);
      if (staleReasons.includes("repository-inputs-changed")) {
        let refreshed;
        try { refreshed = await createAuthoritativeNativeReview(input.runtime, { projectId, repositoryId, proposalRef: body.proposalRef, protectedRef: target.currentHead.protectedRef }); }
        catch (error) { if (error instanceof AuthoritativeNativeReviewError) return sendJson(response, 409, { error: "review input snapshot is unavailable" }); throw error; }
        if (refreshed.review.requiredReviewerIds.length > 0 && !refreshed.review.requiredReviewerIds.includes(reviewer.reviewerId)) return sendJson(response, 403, { error: "reviewer is not required for this review" });
        return sendJson(response, 200, refreshed);
      }
      if (staleReasons.length !== 0) continue;
      return sendJson(response, 200, envelope);
    }
    try {
      const created = await createAuthoritativeNativeReview(input.runtime, { projectId, repositoryId, proposalRef: body.proposalRef, protectedRef: target.currentHead.protectedRef });
      if (created.review.requiredReviewerIds.length > 0 && !created.review.requiredReviewerIds.includes(reviewer.reviewerId)) return sendJson(response, 403, { error: "reviewer is not required for this review" });
      return sendJson(response, 200, created);
    } catch (error) {
      if (error instanceof AuthoritativeNativeReviewError) return sendJson(response, 409, { error: "review candidate is unavailable" });
      throw error;
    }
  });
}

async function serveExactReview(
  input: HumanReviewerHttpInput,
  reviewer: HumanReviewer,
  projectId: string,
  repositoryId: string,
  reviewId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const selected = await inspectExactReview(input, reviewer, projectId, repositoryId, reviewId, request, response);
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
  repositoryId: string,
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
      const selected = await inspectExactReview(input, reviewer, projectId, repositoryId, reviewId, request, response);
      if (selected === undefined || response.writableEnded) return undefined;
      if (!selected.envelope.review.requiredReviewerIds.includes(reviewer.reviewerId)) { sendJson(response, 403, { error: "reviewer is not required for this review" }); return undefined; }
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
      const confirmed = await inspectExactReview(input, reviewer, projectId, repositoryId, reviewId, request, response);
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

async function revokeExactApproval(input: HumanReviewerHttpInput, reviewer: HumanReviewer, projectId: string, repositoryId: string,
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
      const selected = await inspectExactReview(input, reviewer, projectId, repositoryId, reviewId, request, response);
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
  readonly target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
  readonly envelope: NonNullable<Awaited<ReturnType<typeof readAuthoritativeNativeReviewEnvelope>>>;
  readonly staleReasons: readonly string[];
};

async function inspectExactReview(
  input: HumanReviewerHttpInput,
  reviewer: HumanReviewer,
  projectId: string,
  repositoryId: string,
  reviewId: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<ExactReview | undefined> {
  if (!readNativeProjectRegistrations(input.runtime.state).some((entry) => entry.projectId === projectId && entry.repositoryId === repositoryId)) {
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
  let target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
  try {
    target = await resolveAuthoritativeNativeRepositoryTarget(input.runtime, { projectId, repositoryId });
  } catch (error) {
    if (error instanceof Error) {
      sendJson(response, 503, { error: "human review proof is unavailable" });
      return undefined;
    }
    throw error;
  }
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, reviewId);
  if (envelope === undefined || envelope.review.projectId !== projectId || envelope.review.repositoryId !== repositoryId) {
    sendNotFound(response);
    return undefined;
  }
  if (envelope.review.requiredReviewerIds.length > 0 && !envelope.review.requiredReviewerIds.includes(reviewer.reviewerId)) {
    sendJson(response, 403, { error: "reviewer is not required for this review" }); return undefined;
  }
  if (target.currentHead.protectedRef !== envelope.review.protectedRef) {
    try { target = await resolveAuthoritativeNativeRepositoryTarget(input.runtime, { projectId, repositoryId, protectedRef: envelope.review.protectedRef }); }
    catch { sendJson(response, 503, { error: "human review proof is unavailable" }); return undefined; }
  }
  const staleReasons = await nativeHumanReviewStaleReasons(input.runtime, target, envelope.review);
  try {
    const confirmed = await resolveAuthoritativeNativeRepositoryTarget(input.runtime, { projectId, repositoryId, protectedRef: envelope.review.protectedRef });
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

async function listReviewSummaries(input: HumanReviewerHttpInput, reviewer: HumanReviewer, projectId: string, repositoryId: string,
  request: IncomingMessage, response: ServerResponse): Promise<void> {
  await input.serialize(async () => {
    if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) return sendJson(response, 409, { error: "review generation is stale" });
    if (!input.runtime.activated() || !exactActivationIsBound(input.runtime.state, input.runtime.expectedGenerationId, input.runtime.activationTokenDigest)) return sendJson(response, 503, { error: "human review is unavailable" });
    let target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRepositoryTarget>>;
    try { target = await resolveAuthoritativeNativeRepositoryTarget(input.runtime, { projectId, repositoryId }); }
    catch { return sendNotFound(response); }
    const envelopes = (await readAuthoritativeNativeReviewEnvelopes(target.repository))
      .filter((entry) => entry.review.projectId === projectId && entry.review.repositoryId === repositoryId && (entry.review.requiredReviewerIds.length === 0 || entry.review.requiredReviewerIds.includes(reviewer.reviewerId)))
      .sort((left, right) => right.review.createdAt.localeCompare(left.review.createdAt)).slice(0, 100);
    const summaries = [];
    // Every resolver proves the complete repository and its durable objects. Hold
    // one proof per branch for this serialized listing, rather than repeating
    // that repository-wide work for every historical review envelope.
    const branchTargets = new Map([[target.currentHead.protectedRef, target]]);
    const managedBranches = nativeRepositoryBranches(target.imported.policy);
    // Decision records are append-only and the mutation queue is held for this
    // listing. Validate the complete store once, then project each review's view.
    const allDecisions = await readAuthoritativeNativeDecisions(target.repository);
    for (const { review } of envelopes) {
      let branchTarget = branchTargets.get(review.protectedRef);
      if (branchTarget === undefined && Object.hasOwn(managedBranches, review.protectedRef)) {
        try { branchTarget = await resolveAuthoritativeNativeRepositoryTarget(input.runtime, { projectId, repositoryId, protectedRef: review.protectedRef }); }
        catch { return sendJson(response, 503, { error: "human review proof is unavailable" }); }
        branchTargets.set(review.protectedRef, branchTarget);
      }
      // A summary needs only the status. An authoritative head or policy mismatch
      // already proves staleness; exact review reads still collect all reasons.
      const staleReasons = branchTarget === undefined ? ["protected-branch-unmanaged"]
        : review.expectedProtectedHead !== branchTarget.currentHead.commit ? ["protected-head-changed"]
        : review.policyRevision !== branchTarget.imported.policy.policyRevision ? ["policy-changed"]
        : await nativeHumanReviewStaleReasons(input.runtime, branchTarget, review);
      const decisions = { approvals: allDecisions.approvals.filter((approval) => approval.reviewId === review.reviewId),
        revocations: allDecisions.revocations.filter((revocation) => revocation.reviewId === review.reviewId),
        activeApprovals: allDecisions.activeApprovals.filter((approval) => approval.reviewId === review.reviewId) };
      summaries.push({ reviewId: review.reviewId, proposalRef: review.proposalRef, protectedRef: review.protectedRef,
        candidateCommit: review.candidateCommit, createdAt: review.createdAt,
        status: nativeHumanReviewStatus(review.requiredReviewerIds, staleReasons, decisions) });
    }
    if (!input.runtime.activated() || !exactActivationIsBound(input.runtime.state, input.runtime.expectedGenerationId, input.runtime.activationTokenDigest)) return sendJson(response, 503, { error: "human review is unavailable" });
    sendJson(response, 200, summaries);
  });
}
