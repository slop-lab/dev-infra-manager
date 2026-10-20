import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin";
export interface MergeEvidenceAttachment { readonly kind: string; readonly id: string; readonly digest: string }
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
  /** The caller holds the repository authority serialization gate. Do not reenter it. */
  check(input: MergeQualityInput): Promise<readonly MergeEvidenceAttachment[]>;
}
export const MERGE_QUALITY_GUARD_EXTENSION = "dim.merge-policy.quality-guard";
export function mergeQualityGuardExtension(guard: MergeQualityGuard): ControlPlaneExtension {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(guard.name)) throw new Error("invalid merge quality guard name");
  return { kind: MERGE_QUALITY_GUARD_EXTENSION, name: guard.name, value: guard };
}
export function mergeQualityGuards(extensions: readonly ControlPlaneExtension[]): readonly MergeQualityGuard[] {
  return extensions.filter(({ kind }) => kind === MERGE_QUALITY_GUARD_EXTENSION).map(({ name, value }) => {
    if (!("name" in value) || value.name !== name || !("check" in value) || typeof value.check !== "function") throw new Error(`invalid merge quality guard '${name}'`);
    return value as MergeQualityGuard;
  });
}

export function assertRequiredMergeQualityGuards(policyExtensions: Readonly<Record<string, unknown>>, attachments: readonly MergeEvidenceAttachment[], guards: readonly MergeQualityGuard[]): void {
  const names = new Set(guards.map(({ name }) => name));
  if (names.size !== guards.length) throw new Error("duplicate merge quality guard");
  const required = new Set(attachments.map(({ kind }) => kind));
  for (const name of Object.keys(policyExtensions)) if (name !== "code-review" && name !== "merge-policy") required.add(name);
  for (const name of required) if (!names.has(name)) throw new Error(`required merge quality guard '${name}' is unavailable`);
}
