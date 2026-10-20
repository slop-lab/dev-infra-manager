import type { NativeGitBundleConfig } from "./bundle-config.js";
import { activationTokenSha256, exactActivationIsBound } from "./native-bundle-activation.js";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import type { NativeGitBundleServerOptions } from "./native-bundle-server-types.js";
import { readNativeProjectRegistrationsFromDatabase } from "./native-project-registry-state.js";
import { recoverNativeProjectProvisioning } from "./native-project-recovery.js";
import { recoverNativeRootImports } from "./native-root-import-recovery.js";
import { assertGitVersion, type GitExecutableIdentity } from "./repository.js";
import { recoverRepositoryRefChanges } from "./repository-cas.js";

type NativeBundleRuntimeConfig = {
  readonly storageRoot: string;
  readonly gitExecutable: string;
  readonly gitVersion: string;
};

type NativeBundleStartup = {
  readonly activationTokenDigest: string;
  readonly activated: boolean;
  readonly gitIdentity: GitExecutableIdentity;
  readonly runtimeConfig: NativeBundleRuntimeConfig;
};

export async function initializeNativeBundleRuntime(
  config: NativeGitBundleConfig,
  options: NativeGitBundleServerOptions,
  state: NativeGitBundleState
): Promise<NativeBundleStartup> {
  const runtimeConfig = {
    storageRoot: options.stateDirectory,
    gitExecutable: config.gitExecutable,
    gitVersion: config.gitVersion
  };
  const activationTokenDigest = activationTokenSha256(options.activationToken);
  const activated = exactActivationIsBound(state, options.expectedGenerationId, activationTokenDigest);
  const registrations = readNativeProjectRegistrationsFromDatabase(state.database);
  const gitIdentity = await assertGitVersion(runtimeConfig);
  await recoverRepositoryRefChanges({ gitExecutable: config.gitExecutable, gitIdentity, state }, options.stateDirectory);
  await recoverNativeProjectProvisioning({
    state,
    config: runtimeConfig,
    generationId: options.expectedGenerationId,
    registrations,
    activated
  });
  await recoverNativeRootImports({
    state,
    stateDirectory: options.stateDirectory,
    expectedGenerationId: options.expectedGenerationId,
    activated,
    registrations: readNativeProjectRegistrationsFromDatabase(state.database),
    gitExecutable: config.gitExecutable,
    gitIdentity
  });
  return { activationTokenDigest, activated, gitIdentity, runtimeConfig };
}
