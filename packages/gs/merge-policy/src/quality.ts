export interface MergeEvidenceAttachment {
  readonly kind: string;
  readonly id: string;
  readonly digest: string;
}

export interface MergeQualityInput {
  readonly namespaceId: string;
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
  readonly revision: string;
  check(input: MergeQualityInput): Promise<readonly MergeEvidenceAttachment[]>;
}

export function assertMergeQualityGuards(guards: readonly MergeQualityGuard[]): void {
  const names = new Set<string>();
  for (const guard of guards) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(guard.name) || !/^[0-9a-f]{64}$/.test(guard.revision)
      || typeof guard.check !== "function") throw new MergeQualityError("invalid merge quality guard");
    if (names.has(guard.name)) throw new MergeQualityError(`duplicate merge quality guard '${guard.name}'`);
    names.add(guard.name);
  }
}

export function assertRequiredMergeQualityGuards(input: {
  readonly policyExtensions: Readonly<Record<string, unknown>>;
  readonly attachments: readonly MergeEvidenceAttachment[];
  readonly guards: readonly MergeQualityGuard[];
  readonly refPolicyNames: readonly string[];
  readonly integrationPolicyNames: readonly string[];
}): void {
  assertMergeQualityGuards(input.guards);
  const names = new Set(input.guards.map(({ name }) => name));
  const required = new Set(input.attachments.map(({ kind }) => kind));
  for (const name of Object.keys(input.policyExtensions)) {
    if (name !== "code-review" && name !== "merge-policy"
      && !input.refPolicyNames.includes(name) && !input.integrationPolicyNames.includes(name)) required.add(name);
  }
  for (const name of required) {
    if (!names.has(name)) throw new MergeQualityError(`required merge quality guard '${name}' is unavailable`);
  }
}

export class MergeQualityError extends Error {
  readonly name = "MergeQualityError";
}
