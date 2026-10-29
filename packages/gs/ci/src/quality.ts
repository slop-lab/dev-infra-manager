import { createHash } from "node:crypto";
import type { RepositoryPolicy } from "@slop-lab/gs-repository-contracts";
import { checkRequiredExecutionEvidence, type CiExecutionProvider } from "./execution-provider.js";
import { gitCiPolicy } from "./policy.js";
import { readAuthoritativeNativeReviewEnvelope } from "./plan-store.js";

export type GitCiQualityInput = {
  readonly namespaceId: string;
  readonly repositoryId: string;
  readonly reviewId: string;
  readonly repository: string;
  readonly policyDigest: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly expectedProtectedHead: string;
  readonly attachments: readonly { readonly kind: string; readonly id: string; readonly digest: string }[];
};

export type GitCiQualityGuard = {
  readonly name: "git-ci";
  readonly revision: string;
  check(input: GitCiQualityInput): Promise<readonly { readonly kind: "git-ci"; readonly id: string; readonly digest: string }[]>;
};

export interface CiPolicyTargetProvider {
  resolve(input: { readonly namespaceId: string; readonly repositoryId: string }): Promise<{
    readonly repositoryPath: string;
    readonly policyDigest: string;
    readonly policy: RepositoryPolicy;
  }>;
}

export type GitCiQualityTarget = Awaited<ReturnType<CiPolicyTargetProvider["resolve"]>>;

export function createGitCiQualityGuard(options: {
  readonly targets: CiPolicyTargetProvider;
  readonly executionProvider: CiExecutionProvider;
}): GitCiQualityGuard {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.executionProvider.name)
    || !/^[0-9a-f]{64}$/.test(options.executionProvider.revision)) {
    throw new GitCiQualityError("invalid CI execution provider");
  }
  const revision = createHash("sha256").update("gs-ci-quality-guard-v1\0").update(JSON.stringify({
    provider: options.executionProvider.name,
    revision: options.executionProvider.revision,
  })).digest("hex");
  return {
    name: "git-ci",
    revision,
    async check(input) {
      const target = await options.targets.resolve({
        namespaceId: input.namespaceId,
        repositoryId: input.repositoryId,
      });
      const hasPolicy = Object.hasOwn(target.policy.extensions, "git-ci");
      const hasAttachment = input.attachments.some(({ kind }) => kind === "git-ci");
      if (!hasPolicy && !hasAttachment) return [];
      if (!hasPolicy) throw new GitCiQualityError("Git CI review attachment has no trusted policy");
      const envelope = await readAuthoritativeNativeReviewEnvelope(target.repositoryPath, input.reviewId);
      return checkGitCiEnvelope({ target, input, envelope, executionProvider: options.executionProvider });
    },
  };
}

export async function checkGitCiEnvelope(input: {
  readonly target: GitCiQualityTarget;
  readonly input: GitCiQualityInput;
  readonly envelope: Awaited<ReturnType<typeof readAuthoritativeNativeReviewEnvelope>>;
  readonly executionProvider: CiExecutionProvider;
}): Promise<readonly { readonly kind: "git-ci"; readonly id: string; readonly digest: string }[]> {
  const policy = gitCiPolicy(input.target.policy, input.input.repositoryId);
  assertCurrentPlan(input.target.repositoryPath, input.target.policyDigest, input.input,
    input.envelope, policy.requiredJobSetRevision);
  const attachments = [];
  for (const required of policy.requiredJobs) {
    const event = input.envelope?.events.find((candidate) => candidate.executionKind === required.kind
      && candidate.jobName === required.name);
    if (event === undefined) throw new GitCiQualityError("promotion-required Git CI job is missing");
    const evidence = await checkRequiredExecutionEvidence({
      provider: input.executionProvider,
      request: {
        provider: input.executionProvider.name,
        providerRevision: input.executionProvider.revision,
        eventId: event.eventId,
        reviewId: event.reviewId,
        envelopeId: event.envelopeId,
        candidateCommit: event.candidateCommit,
        candidateTree: event.candidateTree,
        policyDigest: input.input.policyDigest,
      },
    });
    attachments.push({ kind: "git-ci" as const, id: `${required.kind}:${required.name}`, digest: evidence.digest });
  }
  return attachments;
}

function assertCurrentPlan(
  repository: string,
  policyDigest: string,
  input: GitCiQualityInput,
  envelope: Awaited<ReturnType<typeof readAuthoritativeNativeReviewEnvelope>>,
  requiredJobSetRevision: string,
): asserts envelope is NonNullable<Awaited<ReturnType<typeof readAuthoritativeNativeReviewEnvelope>>> {
  if (repository !== input.repository || envelope === undefined
    || envelope.review.expectedProtectedHead !== input.expectedProtectedHead
    || envelope.policyDigest !== input.policyDigest || envelope.policyDigest !== policyDigest
    || envelope.review.candidateCommit !== input.candidateCommit
    || envelope.review.candidateTree !== input.candidateTree
    || envelope.qualityRevision !== requiredJobSetRevision || envelope.planning.status !== "valid") {
    throw new GitCiQualityError("Git CI plan is missing, stale or invalid");
  }
}

export class GitCiQualityError extends Error {
  readonly name = "GitCiQualityError";
}
