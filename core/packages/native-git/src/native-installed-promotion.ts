import { createHash } from "node:crypto";
import { readAuthoritativeNativeDecisions } from "./authoritative-native-decision-store.js";
import { readAuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-store.js";
import type { AuthoritativeNativeCandidateRuntime } from "./authoritative-native-root-target.js";
import { resolveAuthoritativeNativeRootTarget } from "./authoritative-native-root-target.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { currentQemuTerminalEvidence } from "./current-qemu-terminal-evidence.js";
import { nativeHumanReviewStaleReasons } from "./native-human-reviewer-freshness.js";
import {
  nativeProjectRootPromotionEvidenceDigest,
  nativeProjectRootPromotionTransitionId,
  type NativeProjectRootPromotionEvidence,
  type NativeProjectRootPromotionTransition
} from "./native-project-root-promotion-codec.js";
import {
  finalizeNativeProjectRootPromotion,
  readNativeProjectRootPromotionFinalized,
  saveNativeProjectRootPromotionIntent
} from "./native-project-root-promotion-state.js";
import { atomicPromote, candidateDescendsFrom } from "./promotion-git.js";

type OrdinaryEvidence = {
  readonly result: string;
  readonly completion: { readonly kind: string; readonly exitCode?: number };
};

export type NativeInstalledPromotionContext = {
  readonly config: NativeGitBundleConfig;
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly stateDirectory: string;
  readonly currentOrdinaryEvidence: (input: {
    readonly projectId: string; readonly reviewId: string; readonly jobName: string;
  }) => Promise<OrdinaryEvidence>;
  readonly hooks?: NativeInstalledPromotionHooks;
};

export type NativeInstalledPromotionHooks = {
  readonly afterIntent?: () => void | Promise<void>;
  readonly afterCompareAndSwap?: () => void | Promise<void>;
};

export type NativeInstalledPromotionResult = {
  readonly schemaVersion: 1;
  readonly outcome: "promoted" | "already-current";
  readonly reviewId: string;
  readonly protectedRef: string;
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly sequence: number;
};

export async function promoteInstalledNativeReview(
  context: NativeInstalledPromotionContext,
  projectId: string,
  reviewId: string
): Promise<NativeInstalledPromotionResult> {
  const target = await resolveAuthoritativeNativeRootTarget(context.runtime, { projectId });
  const envelope = await readAuthoritativeNativeReviewEnvelope(target.repository, reviewId);
  if (envelope === undefined || envelope.review.projectId !== projectId) {
    throw new NativeInstalledPromotionError("review was not found");
  }
  const review = envelope.review;
  const finalized = readNativeProjectRootPromotionFinalized(context.runtime.state.database, projectId)
    .find((transition) => transition.reviewId === reviewId);
  if (finalized !== undefined && target.currentHead.commit === finalized.candidateCommit
    && review.candidateCommit === finalized.candidateCommit && review.candidateTree === finalized.candidateTree) {
    return result("already-current", finalized);
  }
  const staleReasons = await nativeHumanReviewStaleReasons(context.runtime, target, review);
  if (staleReasons.length > 0) throw new NativeInstalledPromotionError("review security tuple is stale");
  const decisions = await readAuthoritativeNativeDecisions(target.repository, reviewId);
  const active = [...decisions.activeApprovals].sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  if (JSON.stringify(active.map(({ reviewerId }) => reviewerId)) !== JSON.stringify(review.requiredReviewerIds)) {
    throw new NativeInstalledPromotionError("human approval evidence is incomplete");
  }
  if (!await candidateDescendsFrom({ gitExecutable: context.runtime.gitExecutable,
    storageRoot: context.stateDirectory }, { projectId, repositoryId: "root" },
  review.expectedProtectedHead, review.candidateCommit)) {
    throw new NativeInstalledPromotionError("candidate does not descend from the protected head");
  }
  const jobs = [] as Array<NativeProjectRootPromotionEvidence["jobs"][number]>;
  for (const required of target.imported.policy.requiredJobs) {
    if (required.kind === "ordinary-sysbox") {
      const evidence = await context.currentOrdinaryEvidence({ projectId, reviewId, jobName: required.name });
      if (evidence.result !== "success" || evidence.completion.kind !== "exited" || evidence.completion.exitCode !== 0) {
        throw new NativeInstalledPromotionError("ordinary evidence is not successful");
      }
      jobs.push({ executionKind: required.kind, jobName: required.name, evidenceClass: required.evidenceClass,
        evidenceDigest: digest("dim-native-ordinary-promotion-evidence-v1\0", evidence) });
    } else {
      if (context.config.qemuCi === undefined) throw new NativeInstalledPromotionError("QEMU evidence service is unavailable");
      jobs.push({ executionKind: required.kind, jobName: required.name, evidenceClass: required.evidenceClass,
        evidenceDigest: await currentQemuTerminalEvidence(context.config.qemuCi, target.repository, envelope, required.name) });
    }
  }
  jobs.sort((left, right) => left.executionKind.localeCompare(right.executionKind)
    || left.jobName.localeCompare(right.jobName));
  const evidence: NativeProjectRootPromotionEvidence = {
    schemaVersion: 1,
    reviewId,
    requiredReviewerIds: review.requiredReviewerIds,
    approvals: active.map(({ reviewerId, recordDigest }) => ({ reviewerId, approvalDigest: recordDigest })),
    jobs
  };
  const evidenceDigest = nativeProjectRootPromotionEvidenceDigest(evidence);
  const identity = {
    projectId,
    importNonce: target.imported.importNonce,
    sequence: target.currentHead.sequence + 1,
    reviewId,
    protectedRef: review.protectedRef,
    proposalRef: review.proposalRef,
    expectedCommit: target.currentHead.commit,
    expectedTree: target.currentHead.tree,
    candidateCommit: review.candidateCommit,
    candidateTree: review.candidateTree,
    decisionGeneration: context.runtime.expectedGenerationId,
    policyDigest: target.imported.policyDigest,
    policyRevision: target.imported.policy.policyRevision,
    requiredReviewRevision: target.imported.policy.requiredReviewRevision,
    requiredJobSetRevision: target.imported.policy.requiredJobSetRevision,
    evidenceDigest
  };
  const transition: NativeProjectRootPromotionTransition = {
    ...identity,
    transitionId: nativeProjectRootPromotionTransitionId(identity),
    evidence
  };
  saveNativeProjectRootPromotionIntent(context.runtime.state.database, transition);
  await context.hooks?.afterIntent?.();
  const updated = await atomicPromote({ gitExecutable: context.runtime.gitExecutable, storageRoot: context.stateDirectory },
    { projectId, repositoryId: "root", protectedRef: review.protectedRef, proposalRef: review.proposalRef },
    review.expectedProtectedHead, review.candidateCommit);
  if (!updated) throw new NativeInstalledPromotionError("protected ref compare-and-swap failed");
  await context.hooks?.afterCompareAndSwap?.();
  finalizeNativeProjectRootPromotion(context.runtime.state.database, transition);
  return result("promoted", transition);
}

function result(outcome: NativeInstalledPromotionResult["outcome"],
  transition: NativeProjectRootPromotionTransition): NativeInstalledPromotionResult {
  return { schemaVersion: 1, outcome, reviewId: transition.reviewId,
    protectedRef: transition.protectedRef, expectedProtectedHead: transition.expectedCommit,
    candidateCommit: transition.candidateCommit, candidateTree: transition.candidateTree,
    sequence: transition.sequence };
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update(JSON.stringify(value)).digest("hex");
}

export class NativeInstalledPromotionError extends Error {
  readonly name = "NativeInstalledPromotionError";
}
