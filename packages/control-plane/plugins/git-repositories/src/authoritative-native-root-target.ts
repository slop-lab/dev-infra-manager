import { nativeRepositoryBranches, nativeRepositoryDefaultRef } from "./native-imported-root-policy.js";
import { readEffectiveRepositoryPolicy } from "./repository-policy-state.js";
import { dirname } from "node:path";
import { z } from "zod";
import { assertNativeGitBundleStateActive, readNativeProjectRegistrations,
  type NativeGitBundleState } from "./native-bundle-state.js";
import { verifyLiveImportedRepository } from "./native-imported-root-verifier.js";
import type { NativeProjectRootImportInstalled } from "./native-project-root-import-codec.js";
import type { NativeProjectRootCurrentHead } from "./repository-ref-state.js";
import type { GitExecutableIdentity } from "./repository.js";

const selectorSchema = z.object({
  projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  protectedRef: z.string().startsWith("refs/heads/").optional()
}).strict().readonly();



export type AuthoritativeNativeCandidateRuntime = {
  readonly activated: () => boolean;
  readonly activationTokenDigest: string;
  readonly expectedGenerationId: string;
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly state: NativeGitBundleState;
};

export type AuthoritativeNativeRepositoryTarget = {
  readonly repository: string;
  readonly currentHead: NativeProjectRootCurrentHead;
  readonly imported: NativeProjectRootImportInstalled;
};

export async function resolveAuthoritativeNativeRepositoryTarget(
  runtime: AuthoritativeNativeCandidateRuntime,
  input: unknown
): Promise<AuthoritativeNativeRepositoryTarget> {
  try {
    if ("stateDirectory" in runtime) {
      throw new AuthoritativeRepositoryError("authoritative native runtime cannot override its owned state directory");
    }
    const selector = selectorSchema.safeParse(input);
    if (!selector.success) {
      throw new AuthoritativeRepositoryError("authoritative native root selector is invalid", { cause: selector.error });
    }
    const registration = readNativeProjectRegistrations(runtime.state)
      .find((entry) => entry.projectId === selector.data.projectId && entry.repositoryId === selector.data.repositoryId);
    if (registration === undefined) {
      throw new AuthoritativeRepositoryError("authoritative native Project is not registered");
    }
    const { policy } = readEffectiveRepositoryPolicy(runtime.state.database, selector.data.projectId, selector.data.repositoryId);
    const protectedRef = selector.data.protectedRef ?? nativeRepositoryDefaultRef(policy);
    if (!(protectedRef in nativeRepositoryBranches(policy))) throw new AuthoritativeRepositoryError("repository target branch is not managed by the effective policy");
    const { imported, currentHead, repository } = await verifyLiveImportedRepository({
      activated: runtime.activated(),
      activationTokenDigest: runtime.activationTokenDigest,
      expectedGenerationId: runtime.expectedGenerationId,
      gitExecutable: runtime.gitExecutable,
      gitIdentity: runtime.gitIdentity,
      ownerHostId: registration.ownerHostId,
      projectId: selector.data.projectId,
      repositoryId: selector.data.repositoryId,
      protectedRef,
      state: runtime.state,
      stateDirectory: dirname(runtime.state.database)
    });
    assertNativeGitBundleStateActive(runtime.state);
    return { imported, currentHead, repository };
  } catch (error) {
    if (error instanceof AuthoritativeRepositoryError) throw error;
    throw new AuthoritativeRepositoryError("authoritative native root target could not be resolved", { cause: error });
  }
}

export class AuthoritativeRepositoryError extends Error { readonly name = "AuthoritativeRepositoryError"; }
