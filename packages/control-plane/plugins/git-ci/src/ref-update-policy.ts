import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import { requireWorkflowCompiler } from "@slop-lab/dim-contracts-ci/workflow-plugin-api";
import { createGitCiRefUpdatePolicy, parseGitCiPolicy } from "@slop-lab/gs-ci";
import type { RepositoryTarget } from "@slop-lab/gs-repository-service";
import {
  createGsRepositoryServiceAdapter,
  refUpdatePolicyExtension,
  type AuthoritativeNativeRepositoryTarget,
  type ProtectedRefChange,
  type RepositoryExtensionContext,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { reviewPreparations } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { createDimCiExecutionProvider, dimCiExecutionProviderRevision } from "./quality.js";
import type { GitCiRuntime } from "./runtime.js";

const revision = createGitCiRefUpdatePolicy({
  name: "dim-execution",
  revision: dimCiExecutionProviderRevision,
  async read() { return undefined; },
}).revision;

export function gitCiRefUpdatePolicyExtension(compilerName: string): ControlPlaneExtension {
  return refUpdatePolicyExtension({
    name: "git-ci",
    revision,
    validate(options) { parseGitCiPolicy(options); },
    async check({ context, target, change }) {
      const runtime: GitCiRuntime = {
        ...context.runtime,
        workflowCompiler: requireWorkflowCompiler(context.extensions, compilerName),
        reviewPreparations: reviewPreparations(context.extensions),
      };
      const provider = createGitCiRefUpdatePolicy(createDimCiExecutionProvider(runtime, {
        projectId: change.projectId,
        repositoryId: change.repositoryId,
      }));
      const adapter = createGsRepositoryServiceAdapter(context);
      await adapter.withBorrowedRead({
        namespaceId: change.projectId,
        repositoryId: change.repositoryId,
        protectedRef: target.currentHead.protectedRef,
      }, async (access) => {
        assertDimTarget(target, access.target);
        await provider.authorize({
          authority: access.authority,
          change: toGsChange(change),
          target: access.target,
          policy: access.target.policy,
        });
      });
    },
  });
}

function assertDimTarget(target: AuthoritativeNativeRepositoryTarget, current: RepositoryTarget): void {
  if (target.repository !== current.repositoryPath || target.currentHead.sequence !== current.head.sequence
    || target.currentHead.protectedRef !== current.head.protectedRef
    || target.currentHead.commit !== current.head.commit || target.currentHead.tree !== current.head.tree
    || target.imported.importNonce !== current.incarnationId
    || target.imported.policyDigest !== current.policyDigest
    || target.imported.ownerHostId !== current.ownerPrincipalId) {
    throw new DimGitCiRefPolicyError("DIM repository target changed during GS CI authorization");
  }
}

function toGsChange(change: ProtectedRefChange) {
  return {
    namespaceId: change.projectId,
    repositoryId: change.repositoryId,
    ...(change.protectedRef === undefined ? {} : { protectedRef: change.protectedRef }),
    proposalRef: change.proposalRef,
    expectedCommit: change.expectedCommit,
    candidateCommit: change.candidateCommit,
    candidateTree: change.candidateTree,
    authorizationId: change.authorizationId,
    evidenceDigest: change.evidenceDigest,
  };
}

export class DimGitCiRefPolicyError extends Error {
  readonly name = "DimGitCiRefPolicyError";
}
