import { join } from "node:path";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { activationTokenSha256, exactActivationIsBound } from "./native-bundle-activation.js";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import type { NativeGitBundleServerOptions } from "./native-bundle-server-types.js";
import { assertAuthoritativeNativeApprovalStore } from "./authoritative-native-approval-store.js";
import { readAuthoritativeNativeDecisions } from "./authoritative-native-decision-store.js";
import { assertAuthoritativeNativeRevocationStore } from "./authoritative-native-revocation-store.js";
import { assertAuthoritativeNativeReviewStore } from "./authoritative-native-review-store.js";
import { assertConfiguredHumanReviewers } from "./native-human-reviewer-policy.js";
import { readNativeProjectRegistrationsFromDatabase } from "./native-project-registry-state.js";
import { recoverNativeProjectProvisioning } from "./native-project-recovery.js";
import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
import { recoverNativeRootImports } from "./native-root-import-recovery.js";
import { assertGitVersion, type GitExecutableIdentity } from "./repository.js";

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
  for (const imported of readNativeProjectRootImportsFromDatabase(state.database)) {
    if (imported.policyFormat === "authoritative-v1") assertConfiguredHumanReviewers(config, imported.policy);
  }
  await Promise.all(readNativeProjectRegistrationsFromDatabase(state.database).map(async (registration) => {
    const repository = join(options.stateDirectory, registration.projectId, `${registration.rootRepositoryId}.git`);
    await assertAuthoritativeNativeReviewStore(repository);
    await assertAuthoritativeNativeApprovalStore(repository);
    await assertAuthoritativeNativeRevocationStore(repository);
    await readAuthoritativeNativeDecisions(repository);
  }));
  return { activationTokenDigest, activated, gitIdentity, runtimeConfig };
}
