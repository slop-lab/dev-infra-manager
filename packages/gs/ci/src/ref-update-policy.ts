import { createHash } from "node:crypto";
import type { RefUpdatePolicy, RepositoryTarget } from "@slop-lab/gs-repository-service";
import { CiExecutionEvidenceError, type CiExecutionProvider } from "./execution-provider.js";
import { checkGitCiEnvelope, GitCiQualityError } from "./quality.js";
import { readAuthoritativeNativeReviewEnvelopes } from "./plan-store.js";

export function createGitCiRefUpdatePolicy(executionProvider: CiExecutionProvider): RefUpdatePolicy {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(executionProvider.name)
    || !/^[0-9a-f]{64}$/.test(executionProvider.revision)) {
    throw new GitCiRefUpdatePolicyError("invalid CI execution provider");
  }
  return {
    name: "git-ci",
    revision: createHash("sha256").update("gs-ci-ref-update-policy-v1\0").update(JSON.stringify({
      provider: executionProvider.name,
      revision: executionProvider.revision,
    })).digest("hex"),
    async authorize(input) {
      if (!Object.hasOwn(input.policy.extensions, "git-ci")) return;
      const target = await input.authority.resolve({
        namespaceId: input.change.namespaceId,
        repositoryId: input.change.repositoryId,
        protectedRef: input.target.head.protectedRef,
      });
      assertTargetProof(input.target, target);
      const envelopes = (await readAuthoritativeNativeReviewEnvelopes(target.repositoryPath)).filter(({ review, policyDigest }) =>
        review.namespaceId === input.change.namespaceId && review.repositoryId === input.change.repositoryId
        && review.protectedRef === target.head.protectedRef && review.proposalRef === input.change.proposalRef
        && review.expectedProtectedHead === input.change.expectedCommit
        && review.candidateCommit === input.change.candidateCommit
        && review.candidateTree === input.change.candidateTree && policyDigest === target.policyDigest);
      let failure: GitCiQualityError | CiExecutionEvidenceError | undefined;
      for (const envelope of envelopes) {
        try {
          await checkGitCiEnvelope({
            target,
            envelope,
            executionProvider,
            input: {
              namespaceId: input.change.namespaceId,
              repositoryId: input.change.repositoryId,
              reviewId: envelope.review.reviewId,
              repository: target.repositoryPath,
              policyDigest: target.policyDigest,
              candidateCommit: input.change.candidateCommit,
              candidateTree: input.change.candidateTree,
              expectedProtectedHead: input.change.expectedCommit,
              attachments: [{ kind: "git-ci", id: envelope.envelopeId, digest: envelope.envelopeId }],
            },
          });
          await input.authority.assertCurrent(target);
          return;
        } catch (error) {
          if (!(error instanceof GitCiQualityError) && !(error instanceof CiExecutionEvidenceError)) throw error;
          failure = error;
        }
      }
      throw failure ?? new GitCiRefUpdatePolicyError("protected ref requires current successful Git CI evidence");
    },
  };
}

function assertTargetProof(expected: Parameters<RefUpdatePolicy["authorize"]>[0]["target"], current: RepositoryTarget): void {
  if (expected.repositoryPath !== current.repositoryPath || expected.incarnationId !== current.incarnationId
    || expected.authorityEpoch !== current.authorityEpoch || expected.policyDigest !== current.policyDigest
    || expected.ownerPrincipalId !== current.ownerPrincipalId || expected.refPolicyRevision !== current.refPolicyRevision
    || expected.head.sequence !== current.head.sequence || expected.head.commit !== current.head.commit
    || expected.head.tree !== current.head.tree || expected.head.protectedRef !== current.head.protectedRef) {
    throw new GitCiRefUpdatePolicyError("repository target changed during CI authorization");
  }
}

export class GitCiRefUpdatePolicyError extends Error {
  readonly name = "GitCiRefUpdatePolicyError";
}
