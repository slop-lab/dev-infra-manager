export type CandidateRef =
  | { readonly kind: "ordinary"; readonly ref: string }
  | { readonly kind: "legacy-proposal"; readonly ref: string }
  | { readonly kind: "reserved"; readonly ref: string }
  | { readonly kind: "invalid"; readonly ref: string };

const proposalPrefix = "refs/heads/proposals/";

export function classifyCandidateRef(ref: string, principalId?: string): CandidateRef {
  if (ref === "refs/heads/proposals" || ref.startsWith(proposalPrefix) || ref.startsWith("refs/dim/")) {
    return principalId !== undefined && isLegacyWorkspaceProposalRef(ref, principalId)
      ? { kind: "legacy-proposal", ref }
      : { kind: "reserved", ref };
  }
  return isOrdinaryCandidateRef(ref) ? { kind: "ordinary", ref } : { kind: "invalid", ref };
}

export function isOrdinaryCandidateRef(ref: string): boolean {
  const prefix = ref.startsWith("refs/heads/") ? "refs/heads/"
    : ref.startsWith("refs/tags/") ? "refs/tags/" : undefined;
  return prefix !== undefined && ref !== "refs/heads/proposals"
    && !ref.startsWith(proposalPrefix) && validRefSuffix(ref.slice(prefix.length));
}

export function isLegacyWorkspaceProposalRef(ref: string, principalId: string): boolean {
  if (!validPrincipalId(principalId)) return false;
  const prefix = `${proposalPrefix}${principalId}/`;
  return ref.startsWith(prefix) && validLegacyProposalSuffix(ref.slice(prefix.length));
}

export function isLegacyProposalRef(ref: string): boolean {
  const match = /^refs\/heads\/proposals\/([A-Za-z0-9_-]{43})\/(.+)$/.exec(ref);
  const principalId = match?.[1];
  return principalId !== undefined && isLegacyWorkspaceProposalRef(ref, principalId);
}

export function isCandidateRef(ref: string): boolean {
  return isOrdinaryCandidateRef(ref) || isLegacyProposalRef(ref);
}

export function candidatePrincipalId(ref: string): string | undefined {
  if (!isLegacyProposalRef(ref)) return undefined;
  return ref.slice(proposalPrefix.length, ref.indexOf("/", proposalPrefix.length));
}

function validPrincipalId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, "base64url").length === 32
    && Buffer.from(value, "base64url").toString("base64url") === value;
}

function validRefSuffix(suffix: string): boolean {
  return suffix.length > 0 && suffix.length <= 1024
    && !/[\x00-\x20\x7f~^:?*[\\\]]/.test(suffix)
    && !suffix.includes("..") && !suffix.includes("@{") && !suffix.includes("//")
    && suffix.split("/").every((part) => part.length > 0 && part !== "."
      && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}

function validLegacyProposalSuffix(suffix: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(suffix) && validRefSuffix(suffix);
}
