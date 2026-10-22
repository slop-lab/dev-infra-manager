import { isDeepStrictEqual } from "node:util";
import type { ReviewPreparation, ReviewPreparationInput } from "@slop-lab/dim-control-plane-plugin-code-review/plugin-api";
import { resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { CandidateExecutionError, executionInputsSchema } from "@slop-lab/dim-contracts-ci/descriptor";
import type { WorkflowCompiler } from "@slop-lab/dim-contracts-ci/workflow-plugin-api";
import { gitCiPolicy } from "./policy.js";
import { saveGitCiPlan } from "./plan-store.js";
import { loadAuthoritativeNativeCandidateJobInputs } from "./authoritative-native-candidate-job-inputs.js";
import { captureExecutionInputs, assertExecutionInputsCurrent } from "./execution-inputs.js";
import type { AuthoritativeNativePlanning } from "./plan-schema.js";
import type { GitCiRuntime } from "./runtime.js";

export function gitCiPreparation(compiler: () => WorkflowCompiler): ReviewPreparation {
  return { name: "git-ci",
    async prepare(input: ReviewPreparationInput) {
      if (!Object.hasOwn(input.target.imported.policy.extensions, "git-ci")) return { inputs: {
        [input.selector.repositoryId]: { commit: input.evidence.candidateCommit, tree: input.evidence.candidateTree }
      } };
      const runtime: GitCiRuntime = { ...input.runtime, workflowCompiler: compiler() };
      const policy = gitCiPolicy(input.target.imported.policy, input.selector.repositoryId);
      let planning: AuthoritativeNativePlanning;
      try {
        const candidate = await loadAuthoritativeNativeCandidateJobInputs(runtime, { projectId: input.selector.projectId, repositoryId: input.selector.repositoryId, protectedRef: input.target.currentHead.protectedRef,
          candidateCommit: input.evidence.candidateCommit, candidateTree: input.evidence.candidateTree });
        planning = { status: "valid", configBlob: candidate.configBlob,
          jobs: await Promise.all(candidate.plan.map(async (job) => ({ executionKind: job.kind, jobName: job.name,
            evidenceClass: "candidate-controlled" as const, script: job.script, argv: job.argv,
            inputs: await captureExecutionInputs(runtime, { projectId: input.selector.projectId, repositoryId: input.selector.repositoryId, protectedRef: input.target.currentHead.protectedRef,
              candidateCommit: input.evidence.candidateCommit, candidateTree: input.evidence.candidateTree, repositories: job.repositories }) }))) };
      } catch (error) { if (!(error instanceof CandidateExecutionError)) throw error; planning = { status: "invalid", reason: "invalid-candidate-job-plan" }; }
      const primary = { [input.selector.repositoryId]: { commit: input.evidence.candidateCommit, tree: input.evidence.candidateTree } };
      const inputs = executionInputsSchema.parse(Object.fromEntries(Object.entries(Object.assign({}, primary,
        ...(planning.status === "valid" ? planning.jobs.map((job) => job.inputs) : []))).sort(([left], [right]) => left.localeCompare(right))));
      const attachment = await saveGitCiPlan(input.target.repository, { schemaVersion: 1, projectId: input.selector.projectId,
        repositoryId: input.selector.repositoryId, expectedProtectedHead: input.target.currentHead.commit,
        candidateCommit: input.evidence.candidateCommit, candidateTree: input.evidence.candidateTree,
        policyDigest: input.target.imported.policyDigest, qualityRevision: policy.requiredJobSetRevision,
        requiredJobs: policy.requiredJobs.map(({ name, kind, evidenceClass }) => ({ executionKind: kind, jobName: name, evidenceClass }))
          .sort((left, right) => left.executionKind.localeCompare(right.executionKind) || left.jobName.localeCompare(right.jobName)), planning });
      return { inputs, attachment };
    },
    async assertCurrent({ runtime: base, review, attachment }) {
      if (attachment === undefined) return;
      const runtime: GitCiRuntime = { ...base, workflowCompiler: compiler() };
      await assertExecutionInputsCurrent(runtime, review);
      const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: review.projectId, repositoryId: review.repositoryId, protectedRef: review.protectedRef });
      if (!isDeepStrictEqual(target.currentHead.commit, review.expectedProtectedHead)) throw new Error("review protected head changed");
    }
  };
}
