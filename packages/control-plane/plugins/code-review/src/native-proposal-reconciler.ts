import { nativeRepositoryBranches } from "@slop-lab/dim-contracts-git";
import { resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { createAuthoritativeNativeReview, type AuthoritativeNativeReviewHooks } from "./authoritative-native-review.js";
import type { AuthoritativeNativeReviewEnvelope } from "./authoritative-native-review-schema.js";
import { readNativeProposalRefs, readNativeProjectRegistrations, type AuthoritativeNativeCandidateRuntime } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
export async function reconcileNativeProposalRefs(
  runtime: AuthoritativeNativeCandidateRuntime,
  projectId: string,
  repositoryId: string,
  proposalRefs: readonly string[],
  hooks: AuthoritativeNativeReviewHooks = {}
): Promise<readonly AuthoritativeNativeReviewEnvelope[]> {
  if (proposalRefs.length === 0) return [];
  const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId, repositoryId });
  if (!Object.hasOwn(target.imported.policy.extensions, "code-review")) return [];
  const envelopes: AuthoritativeNativeReviewEnvelope[] = [];
  for (const proposalRef of proposalRefs) {
    for (const protectedRef of Object.keys(nativeRepositoryBranches(target.imported.policy))) {
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
    envelopes.push(...await reconcileNativeProposalRefs(
      runtime, registration.projectId, registration.repositoryId, [...refs.keys()].sort(), hooks
    ));
  }
  return envelopes;
}
