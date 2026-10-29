import type { GitExecutableIdentity } from "@slop-lab/gs-repository";
import type { RepositoryAccess, RepositoryTarget } from "@slop-lab/gs-repository-service";
import {
  assertAuthoritativeReviewRefs,
  createGitRepositoryReadService,
  inspectAuthoritativeReviewGit,
  readAuthoritativeCandidateFile,
  readAuthoritativeReviewRefs,
  readReviewBlob,
  AuthoritativeReviewGitError,
  type AuthoritativeGitReviewEvidence,
} from "@slop-lab/gs-review";

type PinnedReviewGit = {
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly repository: string;
  readonly signal: AbortSignal;
};

export type AuthoritativeNativeGitReviewEvidence = AuthoritativeGitReviewEvidence;
export { AuthoritativeReviewGitError as AuthoritativeNativeReviewGitError };

export function inspectAuthoritativeNativeReviewGit(input: PinnedReviewGit & {
  readonly protectedRef: string;
  readonly expectedProtectedHead: string;
  readonly proposalRef: string;
}): Promise<AuthoritativeNativeGitReviewEvidence> {
  const runtime = runtimeAccess(input);
  return inspectAuthoritativeReviewGit({
    reader: runtime.reader,
    access: runtime.access,
    protectedRef: input.protectedRef,
    expectedProtectedHead: input.expectedProtectedHead,
    proposalRef: input.proposalRef,
    signal: input.signal,
  });
}

export function assertAuthoritativeNativeReviewRefs(input: PinnedReviewGit & {
  readonly protectedRef: string;
  readonly proposalRef: string;
  readonly expectedProtectedHead: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
}): Promise<void> {
  const runtime = runtimeAccess(input);
  return assertAuthoritativeReviewRefs({
    reader: runtime.reader,
    access: runtime.access,
    protectedRef: input.protectedRef,
    proposalRef: input.proposalRef,
    expectedProtectedHead: input.expectedProtectedHead,
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    signal: input.signal,
  });
}

export function readAuthoritativeNativeReviewRefs(input: PinnedReviewGit & {
  readonly protectedRef: string;
  readonly proposalRef: string;
}) {
  const runtime = runtimeAccess(input);
  return readAuthoritativeReviewRefs({
    reader: runtime.reader,
    access: runtime.access,
    protectedRef: input.protectedRef,
    proposalRef: input.proposalRef,
    signal: input.signal,
  });
}

export function readAuthoritativeNativeCandidateFile(
  input: PinnedReviewGit & { readonly candidateCommit: string },
  path: string,
): Promise<Buffer | undefined> {
  const runtime = runtimeAccess(input);
  return readAuthoritativeCandidateFile({
    reader: runtime.reader,
    access: runtime.access,
    candidateCommit: input.candidateCommit,
    path,
    signal: input.signal,
  });
}

export function readAuthoritativeNativeReviewBlob(input: PinnedReviewGit, objectId: string): Promise<Buffer> {
  const runtime = runtimeAccess(input);
  return readReviewBlob({
    reader: runtime.reader,
    access: runtime.access,
    objectId,
    signal: input.signal,
  });
}

function runtimeAccess(input: PinnedReviewGit): {
  readonly reader: ReturnType<typeof createGitRepositoryReadService>;
  readonly access: RepositoryAccess;
} {
  const target: RepositoryTarget = {
    selector: { namespaceId: "dim-adapter", repositoryId: "review" },
    repositoryPath: input.repository,
    head: { sequence: 0, protectedRef: "refs/heads/main", commit: "0".repeat(40), tree: "0".repeat(40) },
    incarnationId: "dim-review-adapter",
    authorityEpoch: "0".repeat(64),
    policyDigest: "0".repeat(64),
    ownerPrincipalId: "dim-review-adapter",
    refPolicyRevision: "0".repeat(64),
    policy: {
      schemaVersion: 1,
      protectedRef: "refs/heads/main",
      policyRevision: "0".repeat(64),
      extensions: {},
    },
  };
  return {
    reader: createGitRepositoryReadService({
      runtime: { gitExecutable: input.gitExecutable },
      gitIdentity: input.gitIdentity,
    }),
    access: { principalId: "dim-review-adapter", target },
  };
}
