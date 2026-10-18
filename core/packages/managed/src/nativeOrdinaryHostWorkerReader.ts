import { createNativeGitCandidateReadAuthorityFactory } from "./nativeGitCandidateReadAuthority.js";
import type { NativeCandidateReadAuthorityFactoryInput } from "./nativeOrdinaryExecutor.js";

export type NativeGitReaderCredentialScope = {
  readonly projectId: string;
  readonly repositoryId: string;
};

export type NativeGitProjectReaderCredential = NativeGitReaderCredentialScope & {
  readonly username: string;
  readonly password: string;
};

export type NativeGitProjectReaderCredentialResolver = (
  scope: NativeGitReaderCredentialScope
) => NativeGitProjectReaderCredential | undefined | Promise<NativeGitProjectReaderCredential | undefined>;

export type NativeHostReaderDependencies = {
  readonly gitExecutable: string;
  readonly nativeGitEndpoint: string;
  readonly resolveReaderCredential: NativeGitProjectReaderCredentialResolver;
};

export async function createNativeHostClaimReader(
  dependencies: NativeHostReaderDependencies,
  input: NativeCandidateReadAuthorityFactoryInput
) {
  const scope = {
    projectId: input.claim.descriptor.projectId,
    repositoryId: input.claim.descriptor.repositoryId
  };
  const credential = await dependencies.resolveReaderCredential(scope);
  if (credential === undefined || credential.projectId !== scope.projectId
    || credential.repositoryId !== scope.repositoryId) {
    throw new NativeOrdinaryHostWorkerError("native Git reader credential mapping does not match the claim");
  }
  return createNativeGitCandidateReadAuthorityFactory({
    gitExecutable: dependencies.gitExecutable,
    serviceEndpoint: dependencies.nativeGitEndpoint,
    credential: {
      username: credential.username,
      password: credential.password
    }
  })(input);
}

export class NativeOrdinaryHostWorkerError extends Error {
  readonly name = "NativeOrdinaryHostWorkerError";
}
