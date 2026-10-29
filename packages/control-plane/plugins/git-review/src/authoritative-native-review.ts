import type { RepositoryPolicy } from "@slop-lab/gs-repository-contracts";
import type { RepositoryAccess, RepositoryTarget } from "@slop-lab/gs-repository-service";
import {
  createGitRepositoryReadService,
  defaultReviewChangeMatchers,
  reviewRequirementsForChanges as gsReviewRequirementsForChanges,
} from "@slop-lab/gs-review";
import type {
  AuthoritativeNativeChangedPath,
  AuthoritativeNativeReviewEnvelope,
} from "@slop-lab/gs-review-contracts";
import { isCandidateRef } from "@slop-lab/gs-repository-contracts";
import { z } from "zod";
import { createDetachedGsReviewExecution } from "./gs-review-runtime.js";
import type { CodeReviewRuntime } from "./plugin-api.js";

const selectorSchema = z.object({
  projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  protectedRef: z.string().startsWith("refs/heads/").optional(),
  proposalRef: z.string().refine(isCandidateRef),
}).strict().readonly();

export type AuthoritativeNativeReviewHooks = {
  readonly beforeFinalVerification?: () => void | Promise<void>;
  readonly beforePublication?: (input: {
    readonly repository: string;
    readonly envelope: AuthoritativeNativeReviewEnvelope;
  }) => void | Promise<void>;
  readonly publish?: (
    input: { readonly repository: string; readonly envelope: AuthoritativeNativeReviewEnvelope },
    publish: () => Promise<AuthoritativeNativeReviewEnvelope>,
  ) => Promise<AuthoritativeNativeReviewEnvelope>;
};

export async function createAuthoritativeNativeReview(
  runtime: CodeReviewRuntime,
  input: unknown,
  hooks: AuthoritativeNativeReviewHooks = {},
): Promise<AuthoritativeNativeReviewEnvelope> {
  try {
    const selector = selectorSchema.parse(input);
    const execution = await createDetachedGsReviewExecution(runtime, {
      namespaceId: selector.projectId,
      repositoryId: selector.repositoryId,
      ...(selector.protectedRef === undefined ? {} : { protectedRef: selector.protectedRef }),
    }, hooks);
    return execution.feature.createInTransaction(execution.access, {
      namespaceId: selector.projectId,
      repositoryId: selector.repositoryId,
      proposalRef: selector.proposalRef,
      ...(selector.protectedRef === undefined ? {} : { protectedRef: selector.protectedRef }),
    }, false);
  } catch (cause) {
    if (cause instanceof AuthoritativeNativeReviewError) throw cause;
    throw new AuthoritativeNativeReviewError("authoritative native review could not be created", { cause });
  }
}

export async function reviewRequirementsForChanges(
  runtime: CodeReviewRuntime,
  policy: RepositoryPolicy,
  changes: readonly AuthoritativeNativeChangedPath[],
  repository: string,
  candidateCommit: string,
  baseCommit?: string,
  protectedRef?: string,
) {
  const reader = createGitRepositoryReadService({
    runtime: { gitExecutable: runtime.gitExecutable },
    gitIdentity: runtime.gitIdentity,
  });
  const target = syntheticTarget(runtime, policy, repository, candidateCommit, protectedRef);
  const access: RepositoryAccess = { principalId: target.ownerPrincipalId, target };
  return gsReviewRequirementsForChanges({
    reader,
    access,
    matchers: runtime.reviewChangeMatchers ?? defaultReviewChangeMatchers(),
    policy,
    changes,
    candidateCommit,
    ...(baseCommit === undefined ? {} : { baseCommit }),
    ...(protectedRef === undefined ? {} : { protectedRef }),
  });
}

function syntheticTarget(
  runtime: CodeReviewRuntime,
  policy: RepositoryPolicy,
  repositoryPath: string,
  commit: string,
  protectedRef?: string,
): RepositoryTarget {
  return {
    selector: { namespaceId: "dim-adapter", repositoryId: "review" },
    repositoryPath,
    head: {
      sequence: 0,
      protectedRef: protectedRef ?? policy.protectedRef,
      commit,
      tree: commit,
    },
    incarnationId: "dim-review-adapter",
    authorityEpoch: runtime.expectedGenerationId,
    policyDigest: policy.policyRevision,
    ownerPrincipalId: "dim-review-adapter",
    refPolicyRevision: "0".repeat(64),
    policy,
  };
}

export class AuthoritativeNativeReviewError extends Error {
  readonly name = "AuthoritativeNativeReviewError";
}
