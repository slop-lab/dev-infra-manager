import { nativeRepositoryBranches } from "@slop-lab/dim-contracts-git";
import { assertGitExecutableIdentity, resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAuthoritativeNativeReview, type AuthoritativeNativeReviewHooks } from "./authoritative-native-review.js";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import { readNativeProposalRefs, readNativeProjectRegistrations, type AuthoritativeNativeCandidateRuntime } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
const execute = promisify(execFile);
export async function reconcileNativeProposalRefs(
  baseRuntime: AuthoritativeNativeCandidateRuntime,
  projectId: string,
  repositoryId: string,
  proposalRefs: readonly string[],
  hooks: AuthoritativeNativeReviewHooks = {}
): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  return reconcile({ baseRuntime, projectId, repositoryId, proposalRefs, hooks, skipAbsorbed: false });
}

async function reconcile(input: { readonly baseRuntime: AuthoritativeNativeCandidateRuntime; readonly projectId: string;
  readonly repositoryId: string; readonly proposalRefs: readonly string[]; readonly proposalCommits?: ReadonlyMap<string, string>;
  readonly hooks: AuthoritativeNativeReviewHooks; readonly skipAbsorbed: boolean }): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  const { baseRuntime, projectId, repositoryId, proposalRefs, hooks, skipAbsorbed } = input;
  if (proposalRefs.length === 0) return [];
  const runtime = { ...baseRuntime, authoritativeTargetProofs: new Map() };
  const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId, repositoryId });
  if (!Object.hasOwn(target.imported.policy.extensions, "code-review")) return [];
  const envelopes: AuthoritativeNativeReviewEnvelope[] = [];
  for (const proposalRef of proposalRefs) {
    for (const protectedRef of Object.keys(nativeRepositoryBranches(target.imported.policy))) {
      const branch = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId, repositoryId, protectedRef });
      const candidateCommit = input.proposalCommits?.get(proposalRef) ?? await proposalCommit(runtime, branch.repository, proposalRef);
      if (skipAbsorbed && await isCandidateAbsorbed({ runtime, repository: branch.repository, candidateCommit, protectedCommit: branch.currentHead.commit })) continue;
      envelopes.push(await createAuthoritativeNativeReview(runtime, {
        projectId, repositoryId, proposalRef, protectedRef
      }, hooks));
    }
  }
  return envelopes;
}

export async function reconcileRegisteredNativeProposals(
  runtime: AuthoritativeNativeCandidateRuntime,
  hooks: AuthoritativeNativeReviewHooks = {}
): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  const envelopes: AuthoritativeNativeReviewEnvelope[] = [];
  for (const registration of readNativeProjectRegistrations(runtime.state)) {
    if (registration.phase !== "repository-prepared") continue;
    const refs = await readNativeProposalRefs(runtime, registration.projectId, registration.repositoryId);
    envelopes.push(...await reconcile({ baseRuntime: runtime, projectId: registration.projectId, repositoryId: registration.repositoryId,
      proposalRefs: [...refs.keys()].sort(), proposalCommits: refs, hooks, skipAbsorbed: true }));
  }
  return envelopes;
}

async function proposalCommit(runtime: AuthoritativeNativeCandidateRuntime, repository: string, proposalRef: string): Promise<string> {
  await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
  const result = await execute(runtime.gitExecutable, ["--no-replace-objects", "--git-dir", repository, "rev-parse", "--verify", `${proposalRef}^{commit}`], {
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", HOME: "/dev/null", LC_ALL: "C" },
    maxBuffer: 1024, timeout: 30_000,
  });
  await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
  const commit = result.stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error("native proposal commit is invalid");
  return commit;
}

export async function isCandidateAbsorbed(input: { readonly runtime: AuthoritativeNativeCandidateRuntime; readonly repository: string;
  readonly candidateCommit: string; readonly protectedCommit: string }): Promise<boolean> {
  const { runtime, repository, candidateCommit, protectedCommit } = input;
  await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
  try {
    await execute(runtime.gitExecutable, ["--no-replace-objects", "--git-dir", repository, "merge-base", "--is-ancestor", candidateCommit, protectedCommit], {
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", HOME: "/dev/null", LC_ALL: "C" },
      maxBuffer: 1024, timeout: 30_000,
    });
    await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
    return true;
  } catch (error) {
    await assertGitExecutableIdentity(runtime.gitExecutable, runtime.gitIdentity);
    if (error instanceof Error && "code" in error && error.code === 1) return false;
    throw error;
  }
}
