import { nativeRepositoryBranches, nativeRepositoryDefaultRef } from "./native-imported-root-policy.js";
import { readEffectiveRepositoryPolicy } from "./repository-policy-state.js";
import { dirname } from "node:path";
import { z } from "zod";
import { assertNativeGitBundleStateActive, readNativeProjectRegistrations,
  type NativeGitBundleState } from "./native-bundle-state.js";
import { verifyLiveImportedRepository } from "./native-imported-root-verifier.js";
import { assertImportedRepositorySnapshotCurrent } from "./native-imported-root-verifier.js";
import type { NativeProjectRootImportInstalled } from "./native-project-root-import-codec.js";
import type { NativeProjectRootCurrentHead } from "./repository-ref-state.js";
import type { GitExecutableIdentity } from "./repository.js";
import { exactActivationIsBound } from "./native-bundle-activation.js";

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
  readonly authoritativeTargetProofs?: Map<string, Promise<AuthoritativeNativeRepositoryTarget>>;
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
    const key = JSON.stringify(selector.data);
    const cached = runtime.authoritativeTargetProofs?.get(key);
    if (cached !== undefined) return cached;
    const pending = resolveTarget(runtime, selector.data);
    runtime.authoritativeTargetProofs?.set(key, pending);
    const target = await pending;
    runtime.authoritativeTargetProofs?.set(JSON.stringify({
      projectId: selector.data.projectId,
      repositoryId: selector.data.repositoryId,
      protectedRef: target.currentHead.protectedRef
    }), Promise.resolve(target));
    return target;
  } catch (error) {
    if (error instanceof AuthoritativeRepositoryError) throw error;
    throw new AuthoritativeRepositoryError("authoritative native root target could not be resolved", { cause: error });
  }
}

async function resolveTarget(runtime: AuthoritativeNativeCandidateRuntime, selector: z.infer<typeof selectorSchema>): Promise<AuthoritativeNativeRepositoryTarget> {
  const registration = readNativeProjectRegistrations(runtime.state)
    .find((entry) => entry.projectId === selector.projectId && entry.repositoryId === selector.repositoryId);
  if (registration === undefined) throw new AuthoritativeRepositoryError("authoritative native Project is not registered");
  const { policy } = readEffectiveRepositoryPolicy(runtime.state.database, selector.projectId, selector.repositoryId);
  const protectedRef = selector.protectedRef ?? nativeRepositoryDefaultRef(policy);
  if (!(protectedRef in nativeRepositoryBranches(policy))) throw new AuthoritativeRepositoryError("repository target branch is not managed by the effective policy");
  const { imported, currentHead, repository } = await verifyLiveImportedRepository({
    activated: runtime.activated(),
    activationTokenDigest: runtime.activationTokenDigest,
    expectedGenerationId: runtime.expectedGenerationId,
    gitExecutable: runtime.gitExecutable,
    gitIdentity: runtime.gitIdentity,
    ownerHostId: registration.ownerHostId,
    projectId: selector.projectId,
    repositoryId: selector.repositoryId,
    protectedRef,
    state: runtime.state,
    stateDirectory: dirname(runtime.state.database)
  });
  assertNativeGitBundleStateActive(runtime.state);
  return { imported, currentHead, repository };
}

export async function assertAuthoritativeNativeRepositoryTargetCurrent(input: {
  readonly runtime: AuthoritativeNativeCandidateRuntime;
  readonly selector: unknown;
  readonly target: AuthoritativeNativeRepositoryTarget;
}): Promise<void> {
  if (!input.runtime.activated() || !exactActivationIsBound(
    input.runtime.state, input.runtime.expectedGenerationId, input.runtime.activationTokenDigest
  )) throw new AuthoritativeRepositoryError("authoritative native root target is inactive");
  const selector = selectorSchema.parse(input.selector);
  if (selector.protectedRef !== undefined && selector.protectedRef !== input.target.currentHead.protectedRef) {
    throw new AuthoritativeRepositoryError("authoritative native root target branch conflicts with its selector");
  }
  await assertImportedRepositorySnapshotCurrent({
    gitExecutable: input.runtime.gitExecutable,
    gitIdentity: input.runtime.gitIdentity,
    ownerHostId: input.target.imported.ownerHostId,
    projectId: selector.projectId,
    repositoryId: selector.repositoryId,
    protectedRef: input.target.currentHead.protectedRef,
    state: input.runtime.state,
    stateDirectory: dirname(input.runtime.state.database),
    expected: {
      imported: input.target.imported,
      currentHead: input.target.currentHead,
      repository: input.target.repository
    }
  });
  assertNativeGitBundleStateActive(input.runtime.state);
}

export class AuthoritativeRepositoryError extends Error { readonly name = "AuthoritativeRepositoryError"; }
