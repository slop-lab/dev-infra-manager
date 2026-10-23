import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readAuthoritativeNativeReviewEnvelope, readAuthoritativeNativeDecisions, nativeHumanReviewStaleReasons, reviewChangeMatchers } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { repositoryExtensionFactories, refUpdatePolicyExtension, refUpdatePolicies } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import { z } from "zod";
import { assertRequiredMergeQualityGuards, mergeQualityGuards } from "./plugin-api.js";
import type { MergeAuthorizationStore } from "./state.js";

/** Final authorization check shared by every repository CAS caller. */
export function mergeRefUpdatePolicyExtension(
  storeForRepository: (stateDirectory: string) => MergeAuthorizationStore | undefined
): ControlPlaneExtension {
  return refUpdatePolicyExtension({ name: "merge-policy",
      revision: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
      validate(options) { z.object({}).strict().parse(options); },
      async check({ context, target, change }) {
        const store = storeForRepository(context.stateDirectory);
        const entry = store?.read().find(({ authorizationId }) => authorizationId === change.authorizationId);
        const value = entry?.authorization;
        if (!entry || !value || entry.sequence !== undefined || entry.evidenceDigest !== change.evidenceDigest
          || value.projectId !== change.projectId || value.repositoryId !== change.repositoryId
          || value.generationId !== context.runtime.expectedGenerationId || value.policyDigest !== target.imported.policyDigest
          || value.protectedRef !== target.currentHead.protectedRef || value.proposalRef !== change.proposalRef
          || value.expectedCommit !== change.expectedCommit || value.candidateCommit !== change.candidateCommit
          || value.candidateTree !== change.candidateTree) throw new Error("protected ref requires an exact owned merge authorization");
        const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, value.reviewId);
        if (!envelope || envelope.envelopeId !== value.envelopeId || envelope.policyDigest !== value.policyDigest
          || (await nativeHumanReviewStaleReasons({ ...context.runtime, reviewChangeMatchers: reviewChangeMatchers(context.extensions) }, target, envelope.review)).length > 0) throw new Error("merge authorization review is stale");
        const decisions = await readAuthoritativeNativeDecisions(target.repository, value.reviewId);
        const approvals = decisions.activeApprovals.map(({ reviewerId, recordDigest }) => ({ reviewerId, recordDigest })).sort((a, b) => a.reviewerId.localeCompare(b.reviewerId));
        if (JSON.stringify(approvals) !== JSON.stringify(value.approvals)) throw new Error("merge authorization approvals changed");
        const guards = mergeQualityGuards(context.extensions);
        assertRequiredMergeQualityGuards(target.imported.policy.extensions, envelope.attachments, guards, refUpdatePolicies(context.extensions).map(({ name }) => name),
          repositoryExtensionFactories(context.extensions).filter((factory) => factory.requiresMergeQualityGuard === false).flatMap((factory) => factory.policyName === undefined ? [] : [factory.policyName]));
        const attachments = [];
        for (const guard of guards) attachments.push(...await guard.check({ projectId: value.projectId, repositoryId: value.repositoryId,
          reviewId: value.reviewId, repository: target.repository, candidateCommit: value.candidateCommit,
          candidateTree: value.candidateTree, expectedProtectedHead: value.expectedCommit,
          policyDigest: value.policyDigest, attachments: envelope.attachments }));
        attachments.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
        if (JSON.stringify(attachments) !== JSON.stringify(value.attachments)) throw new Error("merge authorization quality evidence changed");
      }
    });
}
