import { join } from "node:path";
import type { GitExecutableIdentity } from "./repository.js";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import { finalizeNativeProjectRootImport } from "./native-root-import-finalization.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
import type { NativeProjectRegistration } from "./native-project-registry-state.js";
import { assertNativeRootRefUnborn } from "./native-root-import-git.js";
import { verifyImportedRootReadOnly } from "./native-imported-root-verifier.js";

type RecoveryOptions = {
  readonly state: NativeGitBundleState;
  readonly stateDirectory: string;
  readonly expectedGenerationId: string;
  readonly activated: boolean;
  readonly registrations: readonly NativeProjectRegistration[];
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
};

export async function recoverNativeRootImports(options: RecoveryOptions): Promise<void> {
  for (const rootImport of readNativeProjectRootImportsFromDatabase(options.state.database)) {
    const originalGeneration = rootImport.generationId === options.expectedGenerationId;
    if (!originalGeneration && rootImport.phase !== "root-imported") {
      throw new NativeProjectRootImportStateError("native Project root import belongs to another generation");
    }
    const registration = options.registrations.find((entry) => entry.projectId === rootImport.projectId);
    if (registration === undefined || registration.phase !== "root-prepared"
      || registration.ownerHostId !== rootImport.ownerHostId
      || registration.rootRepositoryId !== rootImport.rootRepositoryId) {
      throw new NativeProjectRootImportStateError("native Project root import registration binding is invalid");
    }
    if (!originalGeneration) {
      await verifyImportedRootReadOnly({
        state: options.state,
        stateDirectory: options.stateDirectory,
        gitExecutable: options.gitExecutable,
        gitIdentity: options.gitIdentity,
        ownerHostId: rootImport.ownerHostId,
        projectId: rootImport.projectId
      });
      continue;
    }
    if (rootImport.phase === "intent" || rootImport.phase === "bundle-durable" || rootImport.phase === "installing") {
      await assertNativeRootRefUnborn({
        gitExecutable: options.gitExecutable,
        gitIdentity: options.gitIdentity,
        repository: join(options.stateDirectory, rootImport.projectId, "root.git"),
        protectedRef: rootImport.protectedRef,
        signal: AbortSignal.timeout(5_000)
      });
      if (rootImport.phase !== "installing") continue;
    }
    if (!options.activated) {
      throw new NativeProjectRootImportStateError("native Project root import recovery requires exact activation");
    }
    if (rootImport.bundleDigest === null) {
      throw new NativeProjectRootImportStateError("native Project root import bundle binding is invalid");
    }
    await finalizeNativeProjectRootImport({
      state: options.state,
      stateDirectory: options.stateDirectory,
      projectId: rootImport.projectId,
      ownerHostId: rootImport.ownerHostId,
      selector: {
        schemaVersion: 1,
        generationId: rootImport.generationId,
        importNonce: rootImport.importNonce,
        bundleDigest: rootImport.bundleDigest
      },
      gitExecutable: options.gitExecutable,
      gitIdentity: options.gitIdentity,
      signal: AbortSignal.timeout(30_000)
    });
  }
}
