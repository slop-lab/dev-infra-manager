import { createHash } from "node:crypto";
import {
  createGitCiQualityGuard,
  readAuthoritativeNativeReviewEnvelope,
  type CiExecutionProvider,
  type GitCiQualityInput as GsGitCiQualityInput,
} from "@slop-lab/gs-ci";
import { currentExecutionEvidence } from "./execution-evidence.js";
import type { GitCiRuntime } from "./runtime.js";
import { resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";

export const dimCiExecutionProviderRevision = createHash("sha256")
  .update("dim-ci-execution-evidence-adapter-v1\0")
  .digest("hex");

export type GitCiQualityInput = Omit<GsGitCiQualityInput, "namespaceId"> & {
  readonly projectId: string;
};

export const gitCiQualityRevision = createHash("sha256")
  .update("dim-ci-quality-adapter-v1\0")
  .update(dimCiExecutionProviderRevision)
  .digest("hex");

export function createDimCiExecutionProvider(
  runtime: GitCiRuntime,
  selector: { readonly projectId: string; readonly repositoryId: string },
): CiExecutionProvider {
  return {
    name: "dim-execution",
    revision: dimCiExecutionProviderRevision,
    async read(request) {
      const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, selector);
      const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, request.reviewId);
      const event = envelope?.events.find((candidate) => candidate.eventId === request.eventId);
      if (event === undefined || event.envelopeId !== request.envelopeId
        || event.candidateCommit !== request.candidateCommit || event.candidateTree !== request.candidateTree) {
        return undefined;
      }
      const evidence = await currentExecutionEvidence(runtime, target.repository, event);
      const succeeded = evidence.result.result === "success"
        && evidence.result.completion.kind === "exited"
        && "exitCode" in evidence.result.completion
        && evidence.result.completion.exitCode === 0;
      return {
        schemaVersion: 1,
        ...request,
        outcome: succeeded ? "succeeded" : "failed",
        evidenceId: evidence.grant.executionId,
        digest: evidence.digest,
      };
    },
  };
}

export async function assertGitCiPromotable(
  runtime: GitCiRuntime,
  input: GitCiQualityInput,
): Promise<readonly { readonly kind: "git-ci"; readonly id: string; readonly digest: string }[]> {
  const provider = createDimCiExecutionProvider(runtime, {
    projectId: input.projectId,
    repositoryId: input.repositoryId,
  });
  return createGitCiQualityGuard({
    targets: {
      async resolve(selected) {
        const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, {
          projectId: selected.namespaceId,
          repositoryId: selected.repositoryId,
        });
        return {
          repositoryPath: target.repository,
          policyDigest: target.imported.policyDigest,
          policy: target.imported.policy,
        };
      },
    },
    executionProvider: provider,
  }).check({
    namespaceId: input.projectId,
    repositoryId: input.repositoryId,
    reviewId: input.reviewId,
    repository: input.repository,
    policyDigest: input.policyDigest,
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    expectedProtectedHead: input.expectedProtectedHead,
    attachments: input.attachments,
  });
}
