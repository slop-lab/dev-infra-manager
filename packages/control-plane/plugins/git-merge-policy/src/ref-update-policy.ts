import { createHash } from "node:crypto";
import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import {
  refUpdatePolicyExtension,
  type AuthoritativeNativeRepositoryTarget,
  type ProtectedRefChange,
  type RepositoryExtensionContext,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { z } from "zod";
import type { DimGsMergeRuntime } from "./gs-merge-runtime.js";
import type { RepositoryTarget } from "@slop-lab/gs-repository-service";

export function mergeRefUpdatePolicyExtension(
  runtimeFor: (context: RepositoryExtensionContext) => DimGsMergeRuntime,
): ControlPlaneExtension {
  return refUpdatePolicyExtension({
    name: "merge-policy",
    revision: createHash("sha256").update("dim-gs-merge-ref-policy-adapter-v1").digest("hex"),
    validate(options) { z.object({}).strict().parse(options); },
    async check({ context, target, change }) {
      const runtime = runtimeFor(context);
      await runtime.review.adapter.withBorrowedRead({
        namespaceId: change.projectId,
        repositoryId: change.repositoryId,
        protectedRef: target.currentHead.protectedRef,
      }, async (access) => {
        assertDimTarget(target, access.target);
        await runtime.feature.refUpdatePolicy.authorize({
          authority: access.authority,
          change: toGsChange(change),
          target: access.target,
          policy: access.target.policy,
        });
      });
    },
  });
}

function assertDimTarget(
  target: AuthoritativeNativeRepositoryTarget,
  current: RepositoryTarget,
): void {
  if (target.repository !== current.repositoryPath || target.currentHead.sequence !== current.head.sequence
    || target.currentHead.protectedRef !== current.head.protectedRef
    || target.currentHead.commit !== current.head.commit || target.currentHead.tree !== current.head.tree
    || target.imported.importNonce !== current.incarnationId
    || target.imported.policyDigest !== current.policyDigest
    || target.imported.ownerHostId !== current.ownerPrincipalId) {
    throw new DimMergeRefPolicyError("DIM repository target changed during GS merge authorization");
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

export class DimMergeRefPolicyError extends Error {
  readonly name = "DimMergeRefPolicyError";
}
