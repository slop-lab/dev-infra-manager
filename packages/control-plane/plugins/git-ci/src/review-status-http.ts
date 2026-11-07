import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { dimReviewCiStatusSchema, type DimReviewCiJob, type DimReviewCiStatus } from "@slop-lab/dim-contracts-ci/review-status";
import { assertAuthoritativeNativeReviewRefs, readAuthoritativeNativeReviewEnvelope } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { repositoryAccessProvider, RepositoryAccessError, readNativeProjectRootCurrentHeadFromDatabase,
  sendJson, type RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { currentExecutionEvidence, ExecutionConflictError } from "./execution-evidence.js";
import { gitCiPolicy, readAuthoritativeNativeReviewEnvelope as readCiEnvelope } from "@slop-lab/gs-ci";
import type { GitCiRuntime } from "./runtime.js";
import type { AuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";

const executionKindSchema = z.enum(["ordinary-sysbox", "qemu"]);

export async function handleReviewCiStatus(context: RepositoryExtensionContext, runtime: GitCiRuntime,
  http: { readonly request: IncomingMessage; readonly response: ServerResponse; readonly url: URL }): Promise<boolean> {
  const { request, response, url } = http;
  const match = /^\/v1\/projects\/([a-z0-9][a-z0-9-]{0,63})\/repositories\/([a-z0-9][a-z0-9-]{0,63})\/reviews\/([0-9a-f]{64})\/ci$/.exec(url.pathname);
  if (!match || request.method !== "GET" || url.search !== "") return false;
  const projectId = match[1], repositoryId = match[2], reviewId = match[3];
  if (!projectId || !repositoryId || !reviewId) return false;
  try {
    await context.read(async () => {
      const requestRuntime = { ...runtime, authoritativeTargetProofs: new Map() };
      const { target } = await repositoryAccessProvider(context.extensions).authorize({ ...context, runtime: requestRuntime }, request, { projectId, repositoryId });
      const status = await readReviewCiStatus(requestRuntime, target, reviewId);
      await repositoryAccessProvider(context.extensions).authorize({ ...context, runtime: { ...runtime, authoritativeTargetProofs: new Map() } }, request, { projectId, repositoryId });
      if (status === undefined) sendJson(response, 404, { error: "Review not found" });
      else sendJson(response, 200, status);
    });
  } catch (error) {
    if (error instanceof RepositoryAccessError) sendJson(response, error.status, { error: error.message });
    else if (error instanceof Error) sendJson(response, 503, { error: "DIM CI inspection is unavailable; no successful gate is established" });
    else throw error;
  }
  return true;
}

export async function readReviewCiStatus(runtime: GitCiRuntime, target: AuthoritativeNativeRepositoryTarget,
  reviewId: string, evidence: typeof currentExecutionEvidence = currentExecutionEvidence): Promise<DimReviewCiStatus | undefined> {
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, reviewId);
  if (!envelope || envelope.review.projectId !== target.imported.projectId || envelope.review.repositoryId !== target.imported.repositoryId) return;
  const review = envelope.review;
  const common = { schemaVersion: 1 as const, reviewId, generationId: runtime.expectedGenerationId,
    candidateCommit: review.candidateCommit, expectedProtectedHead: review.expectedProtectedHead };
  const publish = (status: Pick<DimReviewCiStatus, "state" | "policy" | "requiredJobs" | "reason">) =>
    dimReviewCiStatusSchema.parse({ ...common, ...status });
  if (!Object.hasOwn(target.imported.policy.extensions, "git-ci")) return publish({ state: "not-configured", policy: "absent", requiredJobs: [] });
  const policy = gitCiPolicy(target.imported.policy, review.repositoryId);
  const head = readNativeProjectRootCurrentHeadFromDatabase(runtime.state.database, review.projectId, review.repositoryId, review.protectedRef);
  const staleJobs = policy.requiredJobs.map(({ name, provider }) => ({
    name, kind: executionKindSchema.parse(provider), status: "stale" as const,
  }));
  if (envelope.policyDigest !== target.imported.policyDigest || head.commit !== review.expectedProtectedHead) {
    return publish({ state: "stale", policy: "enabled", requiredJobs: staleJobs, reason: "stale-review" });
  }
  try {
    await assertAuthoritativeNativeReviewRefs({ gitExecutable: runtime.gitExecutable, gitIdentity: runtime.gitIdentity,
      repository: target.repository, signal: AbortSignal.timeout(30_000), protectedRef: review.protectedRef,
      proposalRef: review.proposalRef, expectedProtectedHead: review.expectedProtectedHead,
      candidateCommit: review.candidateCommit, candidateTree: review.candidateTree });
  } catch {
    return publish({ state: "stale", policy: "enabled", requiredJobs: staleJobs, reason: "stale-review" });
  }
  const plan = await readCiEnvelope(target.repository, reviewId);
  if (!plan || plan.qualityRevision !== policy.requiredJobSetRevision || plan.planning.status !== "valid") {
    return publish({ state: "failed", policy: "enabled", requiredJobs: policy.requiredJobs.map(({ name, provider }) => ({
      name, kind: executionKindSchema.parse(provider), status: "failed",
    })), reason: "invalid-plan" });
  }
  const jobs: DimReviewCiJob[] = [];
  for (const required of policy.requiredJobs) {
    const kind = executionKindSchema.parse(required.provider);
    const event = plan.events.find((entry) => entry.checkName === required.name && entry.provider === required.provider);
    if (!event) { jobs.push({ name: required.name, kind, status: "failed" }); continue; }
    try {
      const { grant, result } = await evidence(runtime, target.repository, event);
      const succeeded = result.result === "success" && result.completion.kind === "exited" && "exitCode" in result.completion && result.completion.exitCode === 0;
      jobs.push({ name: required.name, kind, executionId: grant.executionId, status: succeeded ? "succeeded" : "failed" });
    } catch (error) {
      if (error instanceof ExecutionConflictError) jobs.push({ name: required.name, kind, status: error.code === "evidence-missing" ? "pending" : "stale" });
      else if (error instanceof Error) jobs.push({ name: required.name, kind, status: "unavailable" });
      else throw error;
    }
  }
  const state = jobs.length === 0 ? "not-required" : jobs.some((job) => job.status === "unavailable") ? "unavailable"
    : jobs.some((job) => job.status === "stale") ? "stale" : jobs.some((job) => job.status === "failed") ? "failed"
    : jobs.some((job) => job.status === "pending") ? "pending" : "succeeded";
  return publish({ state, policy: "enabled", requiredJobs: jobs });
}
