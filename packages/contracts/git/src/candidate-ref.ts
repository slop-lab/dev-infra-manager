export type NativeGitCandidateRef =
  | { readonly kind: "ordinary"; readonly ref: string }
  | { readonly kind: "legacy-proposal"; readonly ref: string }
  | { readonly kind: "reserved"; readonly ref: string }
  | { readonly kind: "invalid"; readonly ref: string };

const proposalPrefix = "refs/heads/proposals/";

export function classifyNativeGitCandidateRef(ref: string, workspaceId?: string): NativeGitCandidateRef {
  if (ref === "refs/heads/proposals" || ref.startsWith(proposalPrefix) || ref.startsWith("refs/dim/")) {
    return workspaceId !== undefined && isNativeGitLegacyWorkspaceProposalRef(ref, workspaceId)
      ? { kind: "legacy-proposal", ref }
      : { kind: "reserved", ref };
  }
  return isNativeGitOrdinaryCandidateRef(ref) ? { kind: "ordinary", ref } : { kind: "invalid", ref };
}

export function isNativeGitOrdinaryCandidateRef(ref: string): boolean {
  const prefix = ref.startsWith("refs/heads/") ? "refs/heads/"
    : ref.startsWith("refs/tags/") ? "refs/tags/" : undefined;
  return prefix !== undefined && ref !== "refs/heads/proposals"
    && !ref.startsWith(proposalPrefix) && validRefSuffix(ref.slice(prefix.length));
}

export function isNativeGitLegacyWorkspaceProposalRef(ref: string, workspaceId: string): boolean {
  if (!validWorkspaceId(workspaceId)) return false;
  const prefix = `${proposalPrefix}${workspaceId}/`;
  return ref.startsWith(prefix) && validLegacyProposalSuffix(ref.slice(prefix.length));
}

export function isNativeGitLegacyProposalRef(ref: string): boolean {
  const match = /^refs\/heads\/proposals\/([A-Za-z0-9_-]{43})\/(.+)$/.exec(ref);
  const workspaceId = match?.[1];
  return workspaceId !== undefined && isNativeGitLegacyWorkspaceProposalRef(ref, workspaceId);
}

export function isNativeGitCandidateRef(ref: string): boolean {
  return isNativeGitOrdinaryCandidateRef(ref) || isNativeGitLegacyProposalRef(ref);
}

export function nativeGitCandidateWorkspaceId(ref: string): string | undefined {
  if (!isNativeGitLegacyProposalRef(ref)) return undefined;
  return ref.slice(proposalPrefix.length, ref.indexOf("/", proposalPrefix.length));
}

function validWorkspaceId(value: string): boolean {
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
