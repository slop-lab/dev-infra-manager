import { InvalidArgumentError, Option, type Command } from "commander";
import { print, type JsonFlags } from "@slop-lab/dim-host-core/controller/cli";
import { parseReviewDto } from "@slop-lab/dim-service-client-native-git";

export type ReviewOutputFlags = JsonFlags & { agent?: boolean; full?: boolean };
const maximumItems = 8;

export function reviewOutputOptions(command: Command): Command {
  return command.addOption(new Option("--agent", "print compact JSON with bounded review status and counts").conflicts("full"))
    .option("--full", "include the full patch, changed paths and decision history");
}

/** Domain-owned status projection. Full evidence remains an explicit separate read. */
export function reviewSummary(value: unknown, selection: { project: string; repository: string }) {
  const review = parseReviewDto(value);
  const counts: Record<string, number> = {};
  for (const change of review.changes) counts[change.status] = (counts[change.status] ?? 0) + 1;
  const revoked = new Set(review.revocations.map(({ approvalId }) => approvalId));
  const active = review.approvals.filter(({ approvalId }) => !revoked.has(approvalId));
  const missing = review.requiredReviewerIds.filter((id) => !active.some(({ reviewerId }) => reviewerId === id));
  const jobs = review.ci?.requiredJobs ?? [];
  const jobCounts: Record<string, number> = {};
  for (const job of jobs) jobCounts[job.status] = (jobCounts[job.status] ?? 0) + 1;
  // Successful jobs are counted; actionable jobs take priority in the bounded sample.
  const priority = { failed: 0, stale: 1, unavailable: 2, pending: 3, succeeded: 4 };
  const actionableJobs = jobs.filter(({ status }) => status !== "succeeded").sort((a, b) => priority[a.status] - priority[b.status]);
  return {
    reviewId: review.reviewId, projectId: review.projectId, repositoryId: review.repositoryId,
    status: review.status, proposalRef: review.proposalRef, protectedRef: review.protectedRef,
    candidateCommit: review.candidateCommit, candidateTree: review.candidateTree,
    expectedProtectedHead: review.expectedProtectedHead,
    requiredReviewerIds: review.requiredReviewerIds.slice(0, maximumItems),
    missingReviewerIds: missing.slice(0, maximumItems),
    staleReasons: review.staleReasons.slice(0, maximumItems).map((reason) => reason.length > 160 ? `${reason.slice(0, 160)}…` : reason),
    changes: { total: review.changes.length, byStatus: counts },
    approvals: { total: review.approvals.length, active: active.length, revoked: review.revocations.length },
    reviewers: { required: review.requiredReviewerIds.length, missing: missing.length },
    ci: review.ci === undefined ? null : {
      state: review.ci.state, policy: review.ci.policy,
      reviewId: review.ci.reviewId, candidateCommit: review.ci.candidateCommit,
      expectedProtectedHead: review.ci.expectedProtectedHead,
      ...(review.ci.reason === undefined ? {} : { reason: review.ci.reason }),
      requiredJobs: actionableJobs.slice(0, maximumItems), counts: jobCounts,
      total: jobs.length, omitted: Math.max(0, actionableJobs.length - maximumItems),
    },
    omitted: {
      requiredReviewerIds: Math.max(0, review.requiredReviewerIds.length - maximumItems),
      missingReviewerIds: Math.max(0, missing.length - maximumItems),
      staleReasons: Math.max(0, review.staleReasons.length - maximumItems),
      shortenedStaleReasons: review.staleReasons.slice(0, maximumItems).filter((reason) => reason.length > 160).length,
    },
    fullDetails: ["dim", "project", "review", "inspect", selection.project, selection.repository, review.reviewId, "--full", "--json"],
  };
}

export function printReview(value: unknown, flags: ReviewOutputFlags, selection: { project: string; repository: string }): void {
  if (flags.agent && flags.full) throw new InvalidArgumentError("--agent and --full cannot be combined");
  const output = flags.full ? value : reviewSummary(value, selection);
  if (flags.agent) console.log(JSON.stringify(output));
  else print(output, flags);
}
