import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { readAuthoritativeNativeReviewRefs } from "./authoritative-native-review-git.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRootTarget } from "./authoritative-native-root-target.js";
import { exactActivationIsBound } from "./native-bundle-activation.js";
import { sendJson, sendNotFound } from "./native-bundle-http.js";
import { policyReviewerIds } from "./native-human-reviewer-policy.js";
import { readNativeProjectRegistrations } from "./native-bundle-state.js";

type Credential = { readonly username: string; readonly password: string };
type HumanReviewer = NativeGitBundleConfig["humanReviewers"][number];

type HumanReviewerHttpInput = {
  readonly config: NativeGitBundleConfig;
  readonly knownCredentials: readonly Credential[];
  readonly runtime: AuthoritativeNativeCandidateRuntime;
};

export type NativeHumanReviewerService = {
  readonly handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
};

export function createNativeHumanReviewerService(input: HumanReviewerHttpInput): NativeHumanReviewerService {
  return {
    async handle(request, response, url) {
      const identity = request.method === "GET" && url.pathname === "/v1/human-reviewer-identity"
        && url.search === "";
      const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/root\/reviews\/([0-9a-f]{64})$/
        .exec(url.pathname);
      const review = request.method === "GET" && url.search === "" && match !== null;
      if (!identity && !review) return false;
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
      await serveExactReview(input, reviewer, projectId, reviewId, request, response);
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
  if (!readNativeProjectRegistrations(input.runtime.state).some((entry) => entry.projectId === projectId)) {
    return sendNotFound(response);
  }
  if (request.headers["x-dim-generation-id"] !== input.runtime.expectedGenerationId) {
    return sendJson(response, 409, { error: "review generation conflicts with service startup" });
  }
  if (!input.runtime.activated() || !exactActivationIsBound(
    input.runtime.state,
    input.runtime.expectedGenerationId,
    input.runtime.activationTokenDigest
  )) return sendJson(response, 503, { error: "human review proof is unavailable" });
  let target: Awaited<ReturnType<typeof resolveAuthoritativeNativeRootTarget>>;
  try {
    target = await resolveAuthoritativeNativeRootTarget(input.runtime, { projectId });
  } catch (error) {
    if (error instanceof Error) return sendJson(response, 503, { error: "human review proof is unavailable" });
    throw error;
  }
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, reviewId);
  if (envelope === undefined || envelope.review.projectId !== projectId || envelope.review.repositoryId !== "root") {
    return sendNotFound(response);
  }
  if (!envelope.review.requiredReviewerIds.includes(reviewer.reviewerId)
    || !policyReviewerIds(target.imported.policy).has(reviewer.reviewerId)) {
    return sendJson(response, 403, { error: "reviewer is not required for this review" });
  }
  const staleReasons: string[] = [];
  const review = envelope.review;
  if (review.policyDigest !== target.imported.policyDigest
    || review.policyRevision !== target.imported.policy.policyRevision
    || review.requiredReviewRevision !== target.imported.policy.requiredReviewRevision
    || review.requiredJobSetRevision !== target.imported.policy.requiredJobSetRevision) {
    staleReasons.push("policy-changed");
  }
  if (review.policyDigest !== target.currentHead.policyDigest) staleReasons.push("policy-changed");
  if (review.expectedProtectedHead !== target.currentHead.commit) staleReasons.push("protected-head-changed");
  try {
    const refs = await readAuthoritativeNativeReviewRefs({
      gitExecutable: input.runtime.gitExecutable,
      gitIdentity: input.runtime.gitIdentity,
      repository: target.repository,
      signal: AbortSignal.timeout(30_000),
      protectedRef: review.protectedRef,
      proposalRef: review.proposalRef
    });
    if (refs.protectedHead !== review.expectedProtectedHead) staleReasons.push("protected-head-changed");
    if (refs.candidateCommit !== review.candidateCommit) staleReasons.push("candidate-commit-changed");
    if (refs.candidateTree !== review.candidateTree) staleReasons.push("candidate-tree-changed");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    staleReasons.push("candidate-ref-unavailable");
  }
  try {
    const confirmed = await resolveAuthoritativeNativeRootTarget(input.runtime, { projectId });
    if (JSON.stringify(confirmed) !== JSON.stringify(target)) {
      return sendJson(response, 503, { error: "human review proof is unavailable" });
    }
  } catch (error) {
    if (error instanceof Error) return sendJson(response, 503, { error: "human review proof is unavailable" });
    throw error;
  }
  sendJson(response, 200, {
    status: staleReasons.length === 0 ? "current" : "stale",
    staleReasons: [...new Set(staleReasons)],
    ...envelope
  });
}

function basicAuthorized(request: IncomingMessage, credential: Credential): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
