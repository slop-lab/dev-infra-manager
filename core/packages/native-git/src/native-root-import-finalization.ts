import { join } from "node:path";
import type { GitExecutableIdentity } from "./repository.js";
import {
  beginNativeProjectRootImportInstallation,
  markNativeProjectRootImported,
  markNativeProjectRootObjectsInstalled,
  type NativeGitBundleState
} from "./native-bundle-state.js";
import {
  type NativeProjectRootImport,
  type NativeProjectRootImportFinalizeSelector,
  NativeProjectRootImportConflictError
} from "./native-project-root-import-codec.js";
import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
import { verifyImportedRepositoryReadOnly } from "./native-imported-root-verifier.js";
import {
  assertImportedNativeRoot,
  assertInstalledNativeRootObjects,
  assertNativeRootRefUnborn,
  installNativeRootObjects,
  publishNativeRootRef,
  verifyNativeRootBundle
} from "./native-root-import-git.js";
import { assertDurableNativeRootBundle, rootBundleDirectory, rootBundlePath } from "./native-root-import-storage.js";

type FinalizeOptions = {
  readonly state: NativeGitBundleState;
  readonly stateDirectory: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly ownerHostId: string;
  readonly selector: NativeProjectRootImportFinalizeSelector;
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly signal: AbortSignal;
};

export async function finalizeNativeProjectRootImport(
  options: FinalizeOptions
): Promise<NativeProjectRootImport> {
  let rootImport = requireSelectedImport(options);
  const completedImport = rootImport.phase === "repository-imported";
  const repository = join(options.stateDirectory, options.projectId, `${options.repositoryId}.git`);
  const bundlePath = rootBundlePath(options.stateDirectory, options.projectId, options.repositoryId, rootImport.importNonce);
  const git = {
    gitExecutable: options.gitExecutable,
    gitIdentity: options.gitIdentity,
    signal: options.signal
  };
  if (rootImport.phase !== "intent") {
    await assertDurableNativeRootBundle(options.stateDirectory, options.projectId, options.repositoryId, rootImport.importNonce,
      rootImport.bundleDigest, rootImport.bundleSize);
    await verifyNativeRootBundle({
      ...git,
      directory: rootBundleDirectory(options.stateDirectory, options.projectId, options.repositoryId),
      canonicalRepository: repository,
      bundlePath,
      protectedRef: rootImport.protectedRef,
      expectedCommit: rootImport.expectedCommit
    });
  }
  if (rootImport.phase === "bundle-durable" || rootImport.phase === "installing") {
    await assertNativeRootRefUnborn({ ...git, repository, protectedRef: rootImport.protectedRef });
    rootImport = beginNativeProjectRootImportInstallation(
      options.state, options.projectId, options.repositoryId, options.ownerHostId, options.selector
    );
    if (rootImport.phase === "installing") {
      const resolvedTree = await installNativeRootObjects({
        ...git, repository, bundlePath, protectedRef: rootImport.protectedRef,
        expectedCommit: rootImport.expectedCommit
      });
      rootImport = markNativeProjectRootObjectsInstalled(
        options.state, options.projectId, options.repositoryId, options.selector, resolvedTree
      );
    }
  }
  if (rootImport.phase === "objects-installed") {
    await assertInstalledNativeRootObjects({
      ...git, repository, expectedCommit: rootImport.expectedCommit, resolvedTree: rootImport.resolvedTree
    });
    await publishNativeRootRef({
      ...git, repository, protectedRef: rootImport.protectedRef, expectedCommit: rootImport.expectedCommit
    });
    rootImport = markNativeProjectRootImported(
      options.state, options.projectId, options.repositoryId, options.selector, rootImport.resolvedTree
    );
  }
  if (rootImport.phase === "repository-imported") {
    if (completedImport) {
      await verifyImportedRepositoryReadOnly({
        state: options.state,
        stateDirectory: options.stateDirectory,
        gitExecutable: options.gitExecutable,
        gitIdentity: options.gitIdentity,
        ownerHostId: options.ownerHostId,
        projectId: options.projectId, repositoryId: options.repositoryId
      });
    } else {
      await assertImportedNativeRoot({
        ...git, repository, protectedRef: rootImport.protectedRef,
        expectedCommit: rootImport.expectedCommit, resolvedTree: rootImport.resolvedTree
      });
    }
  }
  return rootImport;
}

function requireSelectedImport(options: FinalizeOptions): NativeProjectRootImport {
  const rootImport = readNativeProjectRootImportsFromDatabase(options.state.database)
    .find((entry) => entry.projectId === options.projectId && entry.repositoryId === options.repositoryId);
  if (rootImport === undefined || rootImport.ownerHostId !== options.ownerHostId
    || rootImport.generationId !== options.selector.generationId
    || rootImport.importNonce !== options.selector.importNonce
    || rootImport.bundleDigest !== options.selector.bundleDigest) {
    throw new NativeProjectRootImportConflictError(options.projectId);
  }
  return rootImport;
}
