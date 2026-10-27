import { dirname, join } from "node:path";
import { nativeRepositoryBranches } from "@slop-lab/dim-contracts-git";
import { readEffectiveRepositoryPolicy, readNativeProjectRootImportsFromDatabase, readNativeProjectRegistrations,
  readNativeRepositoryHeadsFromDatabase, type NativeProjectRootImportInstalled } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { readAuthoritativeNativeReviewRefs } from "./authoritative-native-review-git.js";
import type { CodeReviewRuntime } from "./plugin-api.js";
import { stageRawProposalJob, type RawProposalBinding } from "./raw-proposal-journal.js";

export async function captureRawProposalJobs(input: {
  readonly runtime: CodeReviewRuntime;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly proposalRefs: readonly string[];
}): Promise<number> {
  if (input.proposalRefs.length === 0) return 0;
  const registration = readNativeProjectRegistrations(input.runtime.state).find((entry) =>
    entry.phase === "repository-prepared" && entry.projectId === input.projectId && entry.repositoryId === input.repositoryId);
  const imported = readNativeProjectRootImportsFromDatabase(input.runtime.state.database).find((entry) =>
    entry.projectId === input.projectId && entry.repositoryId === input.repositoryId);
  if (registration === undefined || imported?.phase !== "repository-imported"
    || registration.ownerHostId !== imported.ownerHostId) return 0;
  const effective = readEffectiveRepositoryPolicy(input.runtime.state.database, input.projectId, input.repositoryId);
  if (!Object.hasOwn(effective.policy.extensions, "code-review")) return 0;
  const repository = join(dirname(input.runtime.state.database), input.projectId, `${input.repositoryId}.git`);
  const heads = readNativeRepositoryHeadsFromDatabase(input.runtime.state.database, input.projectId, input.repositoryId)
    .filter((head) => Object.hasOwn(nativeRepositoryBranches(effective.policy), head.protectedRef));
  let staged = 0;
  for (const proposalRef of input.proposalRefs) for (const currentHead of heads) {
    const refs = await readAuthoritativeNativeReviewRefs({
      gitExecutable: input.runtime.gitExecutable, gitIdentity: input.runtime.gitIdentity, repository,
      signal: AbortSignal.timeout(30_000), protectedRef: currentHead.protectedRef, proposalRef
    });
    const previous = await stageRawProposalJob(repository, binding({
      generationId: input.runtime.expectedGenerationId, imported, currentHead, proposalRef, refs
    }));
    if (previous.state.status === "pending" || previous.state.status === "failed") staged += 1;
  }
  return staged;
}

function binding(input: {
  readonly generationId: string;
  readonly imported: NativeProjectRootImportInstalled;
  readonly currentHead: ReturnType<typeof readNativeRepositoryHeadsFromDatabase>[number];
  readonly proposalRef: string;
  readonly refs: Awaited<ReturnType<typeof readAuthoritativeNativeReviewRefs>>;
}): RawProposalBinding {
  const { generationId, imported, currentHead, proposalRef, refs } = input;
  return {
    schemaVersion: 1, generationId, projectId: imported.projectId, repositoryId: imported.repositoryId,
    proposalRef, protectedRef: currentHead.protectedRef, expectedProtectedHead: refs.protectedHead,
    candidateCommit: refs.candidateCommit, candidateTree: refs.candidateTree, policyDigest: currentHead.policyDigest,
    authority: { ownerHostId: imported.ownerHostId, importGenerationId: imported.generationId,
      importNonce: imported.importNonce, bundleDigest: imported.bundleDigest, resolvedTree: imported.resolvedTree,
      headSequence: currentHead.sequence, headTree: currentHead.tree }
  };
}
