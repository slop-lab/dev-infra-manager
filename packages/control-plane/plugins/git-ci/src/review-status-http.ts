import type { IncomingMessage, ServerResponse } from "node:http";
import { reviewCiStatusSchema, type ReviewCiJob, type ReviewCiStatus } from "@slop-lab/dim-contracts-ci/review-status";
import { readAuthoritativeNativeReviewEnvelope } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { repositoryAccessProvider, RepositoryAccessError, readNativeProjectRootCurrentHeadFromDatabase,
  sendJson, type RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { currentExecutionEvidence, ExecutionConflictError } from "./execution-evidence.js";
import { readAuthoritativeNativeReviewEnvelope as readCiEnvelope } from "./plan-store.js";
import { gitCiPolicy } from "./policy.js";
import type { GitCiRuntime } from "./runtime.js";

export async function handleReviewCiStatus(context: RepositoryExtensionContext, runtime: GitCiRuntime,
  http: { readonly request: IncomingMessage; readonly response: ServerResponse; readonly url: URL }): Promise<boolean> {
  const { request, response, url } = http;
  const match = /^\/v1\/projects\/([a-z0-9][a-z0-9-]{0,63})\/repositories\/([a-z0-9][a-z0-9-]{0,63})\/reviews\/([0-9a-f]{64})\/ci$/.exec(url.pathname);
  if (!match || request.method !== "GET" || url.search !== "") return false;
  const projectId = match[1], repositoryId = match[2], reviewId = match[3];
  if (!projectId || !repositoryId || !reviewId) return false;
  try {
    await context.serialize(async () => {
      const requestRuntime = { ...runtime, authoritativeTargetProofs: new Map() };
      const { target } = await repositoryAccessProvider(context.extensions).authorize({ ...context, runtime: requestRuntime }, request, { projectId, repositoryId });
      const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, reviewId);
      if (!envelope || envelope.review.projectId !== projectId || envelope.review.repositoryId !== repositoryId) {
        sendJson(response, 404, { error: "Review not found" }); return;
      }
      const review = envelope.review;
      const common = { schemaVersion: 1 as const, reviewId, generationId: runtime.expectedGenerationId,
        candidateCommit: review.candidateCommit, expectedProtectedHead: review.expectedProtectedHead };
      const publish = (status: Pick<ReviewCiStatus, "state" | "policy" | "requiredJobs" | "reason">) =>
        sendJson(response, 200, reviewCiStatusSchema.parse({ ...common, ...status }));
      if (!Object.hasOwn(target.imported.policy.extensions, "git-ci")) {
        publish({ state: "not-configured", policy: "absent", requiredJobs: [] }); return;
      }
      const policy = gitCiPolicy(target.imported.policy, repositoryId);
      const head = readNativeProjectRootCurrentHeadFromDatabase(runtime.state.database, projectId, repositoryId, review.protectedRef);
      const staleJobs = policy.requiredJobs.map(({ name, kind }) => ({ name, kind, status: "stale" as const }));
      if (envelope.policyDigest !== target.imported.policyDigest || head.commit !== review.expectedProtectedHead) {
        publish({ state: "stale", policy: "enabled", requiredJobs: staleJobs, reason: "stale-review" }); return;
      }
      const plan = await readCiEnvelope(target.repository, reviewId);
      if (!plan || plan.qualityRevision !== policy.requiredJobSetRevision || plan.planning.status !== "valid") {
        publish({ state: "failed", policy: "enabled", requiredJobs: policy.requiredJobs.map(({ name, kind }) => ({ name, kind, status: "failed" })), reason: "invalid-plan" }); return;
      }
      const jobs: ReviewCiJob[] = [];
      for (const required of policy.requiredJobs) {
        const event = plan.events.find((event) => event.jobName === required.name && event.executionKind === required.kind);
        if (!event) { jobs.push({ name: required.name, kind: required.kind, status: "failed" }); continue; }
        try {
          const { grant, result } = await currentExecutionEvidence(requestRuntime, target.repository, event);
          const succeeded = result.result === "success" && result.completion.kind === "exited"
            && "exitCode" in result.completion && result.completion.exitCode === 0;
          jobs.push({ name: required.name, kind: required.kind, executionId: grant.executionId, status: succeeded ? "succeeded" : "failed" });
        } catch (error) {
          if (error instanceof ExecutionConflictError) jobs.push({ name: required.name, kind: required.kind, status: error.code === "evidence-missing" ? "pending" : "stale" });
          else if (error instanceof Error) jobs.push({ name: required.name, kind: required.kind, status: "unavailable" });
          else throw error;
        }
      }
      const state = jobs.length === 0 ? "not-required" : jobs.some((job) => job.status === "unavailable") ? "unavailable"
        : jobs.some((job) => job.status === "stale") ? "stale" : jobs.some((job) => job.status === "failed") ? "failed"
        : jobs.some((job) => job.status === "pending") ? "pending" : "succeeded";
      publish({ state, policy: "enabled", requiredJobs: jobs });
    });
  } catch (error) {
    if (error instanceof RepositoryAccessError) sendJson(response, error.status, { error: error.message });
    else if (error instanceof Error) sendJson(response, 503, { error: "DIM CI inspection is unavailable; no successful gate is established" });
    else throw error;
  }
  return true;
}
