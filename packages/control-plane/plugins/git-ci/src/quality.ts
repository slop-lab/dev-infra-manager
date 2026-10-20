import type { GitCiRuntime } from "./runtime.js";
import { readAuthoritativeNativeReviewEnvelope } from "./plan-store.js";
import { currentExecutionEvidence } from "./execution-evidence.js";
import { resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/extensions";
import { gitCiPolicy } from "./policy.js";

export type GitCiQualityInput = { readonly projectId: string; readonly repositoryId: string; readonly reviewId: string;
  readonly repository: string; readonly policyDigest: string; readonly candidateCommit: string; readonly candidateTree: string;
  readonly expectedProtectedHead: string; readonly attachments: readonly { readonly kind: string; readonly id: string; readonly digest: string }[] };
export async function assertGitCiPromotable(runtime: GitCiRuntime, input: GitCiQualityInput): Promise<readonly { readonly kind: string; readonly id: string; readonly digest: string }[]> {
  const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: input.projectId, repositoryId: input.repositoryId });
  if (!Object.hasOwn(target.imported.policy.extensions, "git-ci") && !input.attachments.some(({ kind }) => kind === "git-ci")) return [];
  if (!Object.hasOwn(target.imported.policy.extensions, "git-ci")) throw new Error("Git CI review attachment has no trusted policy");
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, input.reviewId);
  const policy = gitCiPolicy(target.imported.policy, input.repositoryId);
  if (target.repository !== input.repository || !envelope || envelope.review.expectedProtectedHead !== input.expectedProtectedHead || envelope.policyDigest !== input.policyDigest || envelope.policyDigest !== target.imported.policyDigest
    || envelope.review.candidateCommit !== input.candidateCommit || envelope.review.candidateTree !== input.candidateTree
    || envelope.qualityRevision !== policy.requiredJobSetRevision || envelope.planning.status !== "valid") throw new Error("Git CI plan is missing, stale or invalid");
  const jobs = [];
  for (const required of policy.requiredJobs) {
    const event = envelope.events.find((event) => event.executionKind === required.kind && event.jobName === required.name);
    if (!event) throw new Error("promotion-required Git CI job is missing");
    const evidence = await currentExecutionEvidence(runtime, target.repository, event);
    if (evidence.result.result !== "success" || evidence.result.completion.kind !== "exited" || !("exitCode" in evidence.result.completion) || evidence.result.completion.exitCode !== 0) throw new Error("Git CI execution evidence is not successful");
    jobs.push({ kind: "git-ci", id: `${required.kind}:${required.name}`, digest: evidence.digest });
  }
  return jobs;
}
