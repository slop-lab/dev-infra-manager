import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  CandidateExecutionError,
  executionInputsSchema,
  workflowProviderSchema,
  type WorkflowCompiler,
} from "@slop-lab/gs-ci-contracts";
import type { ReviewPreparation } from "@slop-lab/gs-review";
import { loadCandidateJobInputs, type CandidateReaderProvider } from "./candidate-planning.js";
import { assertExecutionInputsCurrent, captureExecutionInputs } from "./execution-inputs.js";
import { gitCiPolicy } from "./policy.js";
import { saveGitCiPlan } from "./plan-store.js";
import type { AuthoritativeNativePlanning } from "./plan-schema.js";

export type CiWorkflowProvider = {
  readonly name: string;
  readonly revision: string;
  readonly compiler: WorkflowCompiler;
};

export function createGitCiPreparation(options: {
  readonly workflow: CiWorkflowProvider;
  readonly readers: CandidateReaderProvider;
  readonly accepted?: NonNullable<ReviewPreparation["accepted"]>;
}): ReviewPreparation {
  const provider = workflowProviderSchema.parse({
    name: options.workflow.name,
    revision: options.workflow.revision,
  });
  const revision = createHash("sha256").update("gs-ci-review-preparation-v1\0").update(JSON.stringify(provider)).digest("hex");
  return {
    name: "git-ci",
    revision,
    async prepare(input) {
      const primary = {
        [input.request.repositoryId]: {
          commit: input.evidence.candidateCommit,
          tree: input.evidence.candidateTree,
        },
      };
      if (!Object.hasOwn(input.target.policy.extensions, "git-ci")) return { inputs: primary };
      const policy = gitCiPolicy(input.target.policy, input.request.repositoryId);
      let planning: AuthoritativeNativePlanning;
      try {
        const candidate = await loadCandidateJobInputs({
          authority: input.access.authority,
          readers: options.readers,
          compiler: options.workflow.compiler,
          selector: {
            namespaceId: input.request.namespaceId,
            repositoryId: input.request.repositoryId,
            protectedRef: input.target.head.protectedRef,
            candidateCommit: input.evidence.candidateCommit,
            candidateTree: input.evidence.candidateTree,
          },
        });
        planning = {
          status: "valid",
          configBlob: candidate.configBlob,
          jobs: await Promise.all(candidate.plan.map(async (job) => ({
            executionKind: job.provider,
            jobName: job.name,
            evidenceClass: "candidate-controlled" as const,
            script: job.script,
            argv: job.argv,
            inputs: await captureExecutionInputs(input.access.authority, {
              namespaceId: input.request.namespaceId,
              repositoryId: input.request.repositoryId,
              protectedRef: input.target.head.protectedRef,
              candidateCommit: input.evidence.candidateCommit,
              candidateTree: input.evidence.candidateTree,
              repositories: job.repositories,
            }),
          }))),
        };
      } catch (error) {
        if (!(error instanceof CandidateExecutionError)) throw error;
        planning = { status: "invalid", reason: "invalid-candidate-job-plan" };
      }
      const inputs = executionInputsSchema.parse(Object.fromEntries(Object.entries(Object.assign({}, primary,
        ...(planning.status === "valid" ? planning.jobs.map((job) => job.inputs) : [])))
        .sort(([left], [right]) => left.localeCompare(right))));
      const attachment = await saveGitCiPlan(input.target.repositoryPath, {
        schemaVersion: 1,
        projectId: input.request.namespaceId,
        repositoryId: input.request.repositoryId,
        expectedProtectedHead: input.target.head.commit,
        candidateCommit: input.evidence.candidateCommit,
        candidateTree: input.evidence.candidateTree,
        policyDigest: input.target.policyDigest,
        qualityRevision: policy.requiredJobSetRevision,
        requiredJobs: policy.requiredJobs.map(({ name, provider, evidenceClass }) => ({
          executionKind: provider,
          jobName: name,
          evidenceClass,
        })).sort((left, right) => left.executionKind.localeCompare(right.executionKind)
          || left.jobName.localeCompare(right.jobName)),
        planning,
      });
      return { inputs, attachment };
    },
    async assertCurrent({ authority, review, attachment }) {
      if (attachment === undefined) return;
      await assertExecutionInputsCurrent(authority, {
        namespaceId: review.namespaceId,
        repositoryId: review.repositoryId,
        protectedRef: review.protectedRef,
        candidateCommit: review.candidateCommit,
        candidateTree: review.candidateTree,
        inputs: review.inputs,
      });
      const target = await authority.resolve({
        namespaceId: review.namespaceId,
        repositoryId: review.repositoryId,
        protectedRef: review.protectedRef,
      });
      if (!isDeepStrictEqual(target.head.commit, review.expectedProtectedHead)) {
        throw new CandidateExecutionError("review protected head changed");
      }
      await authority.assertCurrent(target);
    },
    ...(options.accepted === undefined ? {} : { accepted: options.accepted }),
  };
}
