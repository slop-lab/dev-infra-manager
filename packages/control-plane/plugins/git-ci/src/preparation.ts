import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { WorkflowCompiler } from "@slop-lab/gs-ci-contracts";
import {
  createGitCiPreparation,
  type CandidateReaderProvider,
} from "@slop-lab/gs-ci";
import type {
  BorrowedRepositoryMutationAuthority,
  RepositoryAuthority,
  RepositoryAvailability,
  RepositoryTarget,
  RepositoryTargetSelector,
} from "@slop-lab/gs-repository-service";
import {
  readNativeProjectRegistrations,
  findFinalizedProtectedRef,
  resolveAuthoritativeNativeRepositoryTarget,
  type AuthoritativeNativeRepositoryTarget,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type {
  ReviewPreparation,
} from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import type { GitCiRuntime } from "./runtime.js";
import { toGsReviewIdentity, toGsReviewIdentityWithoutInputs } from "./review-adapter.js";

export function gitCiPreparation(
  compiler: () => WorkflowCompiler,
  accepted?: NonNullable<ReviewPreparation["accepted"]>,
  providerName = "dim",
): ReviewPreparation {
  const selectedCompiler = (): WorkflowCompiler & { readonly revision: string } => {
    const value = compiler();
    if (!/^[0-9a-f]{64}$/.test(value.revision ?? "")) {
      throw new DimGitCiPreparationError("workflow compiler revision is unavailable");
    }
    return { ...value, revision: value.revision ?? "" };
  };
  const create = (runtime: GitCiRuntime) => {
    const authority = createDimCiAuthority(runtime);
    const readers: CandidateReaderProvider = {
      open: (target) => ({
        executable: runtime.gitExecutable,
        repositoryPath: target.repositoryPath,
        identity: runtime.gitIdentity,
      }),
    };
    const workflow = selectedCompiler();
    return {
      authority,
      preparation: createGitCiPreparation({
        workflow: { name: providerName, revision: workflow.revision, compiler: workflow },
        readers,
      }),
    };
  };
  return {
    name: "git-ci",
    revision: createHash("sha256").update("dim-gs-ci-preparation-adapter-v2\0").update(providerName).digest("hex"),
    async prepare(input) {
      if (!Object.hasOwn(input.target.imported.policy.extensions, "git-ci")) {
        return { inputs: {
          [input.selector.repositoryId]: {
            commit: input.evidence.candidateCommit,
            tree: input.evidence.candidateTree,
          },
        } };
      }
      const runtime: GitCiRuntime = { ...input.runtime, workflowCompiler: selectedCompiler() };
      const core = create(runtime);
      const target = toGsCiTarget(runtime, input.target);
      return core.preparation.prepare({
        access: { authority: core.authority, target },
        request: {
          namespaceId: input.selector.projectId,
          repositoryId: input.selector.repositoryId,
          proposalRef: input.selector.proposalRef,
          ...(input.selector.protectedRef === undefined ? {} : { protectedRef: input.selector.protectedRef }),
        },
        target,
        evidence: input.evidence,
        identity: toGsReviewIdentityWithoutInputs(input.identity),
      });
    },
    async assertCurrent(input) {
      if (input.attachment === undefined) return;
      const runtime: GitCiRuntime = { ...input.runtime, workflowCompiler: selectedCompiler() };
      const core = create(runtime);
      await core.preparation.assertCurrent?.({
        authority: core.authority,
        review: toGsReviewIdentity(input.review),
        ...(input.attachment === undefined ? {} : { attachment: input.attachment }),
      });
    },
    ...(accepted === undefined ? {} : { accepted }),
  };
}

export function createDimCiAuthority(runtime: GitCiRuntime): RepositoryAuthority & BorrowedRepositoryMutationAuthority {
  const authority = {
    authorityEpoch: runtime.expectedGenerationId,
    async resolve(selector: RepositoryTargetSelector): Promise<RepositoryTarget> {
      const target = await resolveAuthoritativeNativeRepositoryTarget(
        { ...runtime, authoritativeTargetProofs: new Map() },
        toDimSelector(selector),
      );
      return toGsCiTarget(runtime, target);
    },
    async assertCurrent(target: RepositoryTarget): Promise<void> {
      const current = await authority.resolve({ ...target.selector, protectedRef: target.head.protectedRef });
      if (!isDeepStrictEqual(current, target)) {
        throw new DimGitCiPreparationError("repository target changed during CI preparation");
      }
    },
    async list(namespace: { readonly namespaceId: string }): Promise<readonly RepositoryTarget[]> {
      return Promise.all((await authority.listSelectors(namespace)).map((selector) => authority.resolve(selector)));
    },
    async listSelectors(namespace?: { readonly namespaceId: string }) {
      return readNativeProjectRegistrations(runtime.state)
        .filter((entry) => namespace === undefined || entry.projectId === namespace.namespaceId)
        .map((entry) => ({ namespaceId: entry.projectId, repositoryId: entry.repositoryId }));
    },
    async availability(selector: RepositoryTargetSelector): Promise<RepositoryAvailability> {
      const exists = (await authority.listSelectors({ namespaceId: selector.namespaceId }))
        .some((entry) => entry.repositoryId === selector.repositoryId);
      return exists ? { kind: "available", target: await authority.resolve(selector) } : { kind: "not-found" };
    },
    findFinalized: (query: Parameters<RepositoryAuthority["findFinalized"]>[0]) =>
      findFinalizedProtectedRef(runtime, query),
    async promote(): Promise<never> {
      throw new DimGitCiPreparationError("CI preparation cannot promote a protected ref");
    },
  };
  return authority;
}

export function toGsCiTarget(runtime: GitCiRuntime, target: AuthoritativeNativeRepositoryTarget): RepositoryTarget {
  return {
    selector: { namespaceId: target.imported.projectId, repositoryId: target.imported.repositoryId },
    repositoryPath: target.repository,
    head: target.currentHead,
    incarnationId: target.imported.importNonce,
    authorityEpoch: runtime.expectedGenerationId,
    policyDigest: target.imported.policyDigest,
    ownerPrincipalId: target.imported.ownerHostId,
    refPolicyRevision: target.imported.policy.policyRevision,
    policy: target.imported.policy,
  };
}

function toDimSelector(selector: RepositoryTargetSelector): {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly protectedRef?: string;
} {
  return {
    projectId: selector.namespaceId,
    repositoryId: selector.repositoryId,
    ...(selector.protectedRef === undefined ? {} : { protectedRef: selector.protectedRef }),
  };
}

export class DimGitCiPreparationError extends Error {
  readonly name = "DimGitCiPreparationError";
}
