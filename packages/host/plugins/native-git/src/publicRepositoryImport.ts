import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acquireLifecycleLock, atomicWrite, UserError, validateLifecycleName } from "@slop-lab/dim-host-core";
import { loadPrivateJson } from "@slop-lab/dim-native-git-client";
import { preparePublicGitSource, publicGitBranch, publicGitUrl } from "./public-git-source.js";
import { compileNativeRepositoryBootstrapPolicy } from "./nativeRootBootstrapPolicy.js";
import { bootstrapNativeProjectRepository, resumeNativeProjectRepository } from "./nativeProjectBootstrap.js";
import { NativeProjectDraftStore } from "./nativeProjectDraftStore.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { loadNativeGitRootImporterConnection } from "./nativeGitRootImporterConnection.js";
import { createNativeGitRootImporterClient } from "./nativeGitRootImporterClient.js";
import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";

export interface PublicRepositoryImportInput {
  name: string; projectId: string; repositoryId: string; url: string; branch?: string;
  stateRoot: string; selected: NativeControlPlaneConnection; registrarConnectionFile: string; importerConnectionFile: string;
  reviewerId: string; extensions?: unknown; gitExecutable?: string; signal: AbortSignal;
}
/** Trusted injection is for operator-controlled transports and disposable tests, never repository input. */
export interface PublicRepositoryImportDependencies { prepareSource?: typeof preparePublicGitSource }
export async function importNativeProjectPublicRepository(input: PublicRepositoryImportInput, dependencies: PublicRepositoryImportDependencies = {}) {
  validateLifecycleName(input.name, "project");
  if (![input.projectId, input.repositoryId].every((id) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id))) throw new UserError("invalid project or repository identity");
  const url = publicGitUrl(input.url).toString(), branch = input.branch === undefined ? undefined : publicGitBranch(input.branch);
  input.signal.throwIfAborted();
  const state = new NativeProjectPendingStore(input.stateRoot), project = await state.read(input.name, input.selected.hostId);
  if (!project || project.projectId !== input.projectId) throw new UserError("Project does not exist on this controller");
  const lock = await acquireLifecycleLock({ root: input.stateRoot, name: `url-import-${createHash("sha256").update(input.projectId).digest("hex").slice(0, 24)}`, description: "Public repository import" });
  try {
    const intentPath = join(input.stateRoot, "native-project-url-imports", input.name, `${input.repositoryId}.json`);
    const intent = { schemaVersion: 1, projectId: input.projectId, repositoryId: input.repositoryId, ownerHostId: input.selected.hostId, generationId: input.selected.nativeGit.generationId, url, branch: branch ?? null };
    let previous: unknown;
    try { await lstat(intentPath); previous = await loadPrivateJson(intentPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous !== undefined && !isDeepStrictEqual(previous, intent)) throw new UserError("Repository URL import retry changes its immutable source intent");
    const drafts = new NativeProjectDraftStore(input.stateRoot), existing = await drafts.read(input.name, input.repositoryId);
    const bootstrap = { name: input.name, projectId: input.projectId, repositoryId: input.repositoryId, stateRoot: input.stateRoot,
      registrarConnectionFile: input.registrarConnectionFile, importerConnectionFile: input.importerConnectionFile, signal: input.signal,
      selectedControlPlane: { endpoint: input.selected.nativeGit.endpoint, hostId: input.selected.hostId, generationId: input.selected.nativeGit.generationId } };
    if (existing) {
      if (previous === undefined) throw new UserError("Existing repository draft has no matching public URL import intent");
      if (input.extensions !== undefined && !isDeepStrictEqual(compileNativeRepositoryBootstrapPolicy({ repositoryId: input.repositoryId, protectedRef: existing.protectedRef, extensions: input.extensions }).repositoryPolicy, existing.repositoryPolicy)) throw new UserError("Repository URL import retry changes its immutable policy");
      await resumeNativeProjectRepository(bootstrap);
    } else {
      if (project.repositories[input.repositoryId]) throw new UserError("Existing repository has no matching public URL import draft");
      const source = await (dependencies.prepareSource ?? preparePublicGitSource)({ url, ...(branch === undefined ? {} : { branch }), scratchRoot: input.stateRoot, gitExecutable: input.gitExecutable ?? "/usr/bin/git", signal: input.signal });
      try {
        if (previous === undefined) await atomicWrite(intentPath, intent);
        await bootstrapNativeProjectRepository({ ...bootstrap, sourceRepository: source.directory, selectedRef: source.selectedRef, scratchRoot: input.stateRoot, gitExecutable: input.gitExecutable ?? "/usr/bin/git",
          policySource: { kind: "manifest-free", extensions: input.extensions ?? { "code-review": { requiredReviewerIds: [], pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: [input.reviewerId] }] }, "merge-policy": {} } } });
      } finally { await source.cleanup(); }
    }
    const connection = await loadNativeGitRootImporterConnection(input.importerConnectionFile);
    if (connection.endpoint !== input.selected.nativeGit.endpoint || connection.hostId !== input.selected.hostId || connection.generationId !== input.selected.nativeGit.generationId) throw new UserError("Repository importer conflicts with selected control-plane generation");
    const importer = createNativeGitRootImporterClient(connection);
    let record = await state.admitRepository(input.name, input.repositoryId, importer, input.selected, input.signal);
    if (record.phase === "configuring" && Object.keys(record.repositories).length === 1) record = await state.configure(input.name, { configurationRepositoryId: input.repositoryId, defaultWorkingRepositoryId: input.repositoryId }, input.selected, input.signal);
    const repository = record.repositories[input.repositoryId]; if (!repository) throw new UserError("Imported repository is absent from the controller catalog");
    return { projectId: record.projectId, repositoryId: input.repositoryId, protectedRef: repository.protectedRef, commit: repository.commit, tree: repository.tree, projectReady: record.phase === "ready" };
  } finally { await lock(); }
}
