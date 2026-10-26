import type { ReviewCiJob, ReviewCiStatus } from "@slop-lab/dim-contracts-ci/review-status";
import type { AuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { currentExecutionEvidence, ExecutionConflictError } from "./execution-evidence.js";
import { readAuthoritativeNativeReviewEnvelope } from "./plan-store.js";
import { readReviewCiStatus } from "./review-status-http.js";
import type { GitCiRuntime } from "./runtime.js";

export async function readWorkspaceCiStatus(runtime: GitCiRuntime, target: AuthoritativeNativeRepositoryTarget, reviewId: string): Promise<{
  readonly state: ReviewCiStatus["state"]; readonly review: ReviewCiStatus; readonly jobs: readonly ReviewCiJob[];
} | undefined> {
  const review = await readReviewCiStatus(runtime, target, reviewId);
  if (!review) return;
  const plan = await readAuthoritativeNativeReviewEnvelope(target.repository, reviewId);
  if (review.policy !== "enabled" || !plan || plan.planning.status !== "valid") return { state: "unavailable", review, jobs: [] };
  const jobs: ReviewCiJob[] = [];
  for (const event of plan.events) {
    const identity = { name: event.jobName, kind: event.executionKind };
    try {
      const { grant, result } = await currentExecutionEvidence(runtime, target.repository, event);
      jobs.push({ ...identity, executionId: grant.executionId, status: result.result === "success" && result.completion.kind === "exited" && "exitCode" in result.completion && result.completion.exitCode === 0 ? "succeeded" : "failed" });
    } catch (error) {
      if (error instanceof ExecutionConflictError) jobs.push({ ...identity, status: error.code === "evidence-missing" ? "pending" : "stale" });
      else if (error instanceof Error) jobs.push({ ...identity, status: "unavailable" });
      else throw error;
    }
  }
  const state = ["failed", "stale", "unavailable"].includes(review.state) ? review.state : jobs.length === 0 ? "not-required"
    : jobs.some((job) => job.status === "unavailable") ? "unavailable" : jobs.some((job) => job.status === "stale") ? "stale"
      : jobs.some((job) => job.status === "failed") ? "failed" : jobs.some((job) => job.status === "pending") ? "pending" : "succeeded";
  return { state, review, jobs };
}
