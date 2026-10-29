import { createHash } from "node:crypto";
import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import {
  assertRequiredMergeQualityGuards as assertGsRequiredMergeQualityGuards,
  type MergeEvidenceAttachment,
  type MergeQualityGuard as GsMergeQualityGuard,
} from "@slop-lab/gs-merge-policy";

export type { MergeEvidenceAttachment } from "@slop-lab/gs-merge-policy";

export interface MergeQualityInput {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly reviewId: string;
  readonly repository: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly expectedProtectedHead: string;
  readonly policyDigest: string;
  readonly attachments: readonly MergeEvidenceAttachment[];
}

export interface MergeQualityGuard {
  readonly name: string;
  readonly revision?: string;
  check(input: MergeQualityInput): Promise<readonly MergeEvidenceAttachment[]>;
}

export const MERGE_QUALITY_GUARD_EXTENSION = "dim.merge-policy.quality-guard";

export function mergeQualityGuardExtension(guard: MergeQualityGuard): ControlPlaneExtension {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(guard.name)) throw new MergeQualityGuardAdapterError("invalid merge quality guard name");
  return { kind: MERGE_QUALITY_GUARD_EXTENSION, name: guard.name, value: guard };
}

export function mergeQualityGuards(extensions: readonly ControlPlaneExtension[]): readonly MergeQualityGuard[] {
  return extensions.filter(({ kind }) => kind === MERGE_QUALITY_GUARD_EXTENSION).map(({ name, value }) => {
    if (!isMergeQualityGuard(value) || value.name !== name) {
      throw new MergeQualityGuardAdapterError(`invalid merge quality guard '${name}'`);
    }
    return value;
  });
}

export function toGsMergeQualityGuards(guards: readonly MergeQualityGuard[]): readonly GsMergeQualityGuard[] {
  return guards.map((guard) => ({
    name: guard.name,
    revision: guard.revision ?? createHash("sha256")
      .update("dim-merge-quality-guard-adapter-v1\0").update(guard.name).digest("hex"),
    check: (input) => guard.check({
      projectId: input.namespaceId,
      repositoryId: input.repositoryId,
      reviewId: input.reviewId,
      repository: input.repository,
      candidateCommit: input.candidateCommit,
      candidateTree: input.candidateTree,
      expectedProtectedHead: input.expectedProtectedHead,
      policyDigest: input.policyDigest,
      attachments: input.attachments,
    }),
  }));
}

export function assertRequiredMergeQualityGuards(
  policyExtensions: Readonly<Record<string, unknown>>,
  attachments: readonly MergeEvidenceAttachment[],
  guards: readonly MergeQualityGuard[],
  refPolicyNames: readonly string[] = [],
  integrationPolicyNames: readonly string[] = [],
): void {
  assertGsRequiredMergeQualityGuards({
    policyExtensions,
    attachments,
    guards: toGsMergeQualityGuards(guards),
    refPolicyNames,
    integrationPolicyNames,
  });
}

function isMergeQualityGuard(value: unknown): value is MergeQualityGuard {
  return typeof value === "object" && value !== null
    && "name" in value && typeof value.name === "string"
    && "check" in value && typeof value.check === "function";
}

export class MergeQualityGuardAdapterError extends Error {
  readonly name = "MergeQualityGuardAdapterError";
}
