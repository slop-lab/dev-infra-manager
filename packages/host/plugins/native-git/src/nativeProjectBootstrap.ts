import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { UserError } from "@slop-lab/dim-host-core";
import { createNodeNativeGitAdmissionHttpClient } from "@slop-lab/dim-contracts-git/http";
import { createNativeGitProjectRegistrarClient, type NativeGitProjectRegistrarClient } from "./nativeGitProjectRegistrarClient.js";
import { loadNativeGitProjectRegistrarConnection } from "./nativeGitProjectRegistrarConnection.js";
import { createNativeGitRootImporterClient,
  type NativeGitRootImporterClient, type NativeGitRootImportResult } from "./nativeGitRootImporterClient.js";
import { loadNativeGitRootImporterConnection } from "./nativeGitRootImporterConnection.js";
import type { NativeProjectDraft } from "./nativeProjectDraftCodec.js";
import { NativeProjectPendingStore } from "./nativeProjectPendingStore.js";
import { NativeProjectDraftStore } from "./nativeProjectDraftStore.js";
import { prepareNativeRootBootstrapGit, type NativeRootBootstrapGitInput } from "./nativeRootBootstrapGit.js";

export type NativeProjectBootstrapInput = NativeRootBootstrapGitInput & {
  readonly name: string;
  readonly projectId: string;
  readonly stateRoot: string;
  readonly registrarConnectionFile: string;
  readonly importerConnectionFile: string;
  readonly selectedControlPlane?: { endpoint: string; hostId: string; generationId: string };
};

export class NativeProjectBootstrapError extends UserError {
  readonly name = "NativeProjectBootstrapError";
}

export async function bootstrapNativeProjectRepository(input: NativeProjectBootstrapInput): Promise<NativeProjectDraft> {
  input.signal.throwIfAborted();
  const { registrar, importer } = await bootstrapClients(input);
  const project = await new NativeProjectPendingStore(input.stateRoot).read(input.name, registrar.hostId);
  if (!project || project.projectId !== input.projectId) throw new NativeProjectBootstrapError("create this Project identity before importing a repository");
  const plan = await prepareNativeRootBootstrapGit(input);
  try {
    const store = new NativeProjectDraftStore(input.stateRoot);
    const draft = await store.claim({ name: input.name, projectId: input.projectId,
      ownerHostId: registrar.hostId, generationId: registrar.generationId,
      repositoryId: plan.repositoryId, protectedRef: plan.protectedRef,
      expectedCommit: plan.expectedCommit, expectedTree: plan.resolvedTree,
      repositoryPolicy: plan.repositoryPolicy,
      bundlePath: plan.bundlePath });
    return await finishDraft(input.stateRoot, draft, store, registrar, importer, input.signal);
  } finally {
    await plan.cleanup();
  }
}

/** Resume durable immutable artifacts instead of consulting a possibly moved upstream again. */
export async function resumeNativeProjectRepository(input: Pick<NativeProjectBootstrapInput, "name" | "projectId" | "repositoryId" | "stateRoot" | "registrarConnectionFile" | "importerConnectionFile" | "signal" | "selectedControlPlane">): Promise<NativeProjectDraft> {
  input.signal.throwIfAborted();
  const { registrar, importer } = await bootstrapClients(input), store = new NativeProjectDraftStore(input.stateRoot);
  const draft = await store.read(input.name, input.repositoryId);
  if (!draft || draft.projectId !== input.projectId || draft.ownerHostId !== registrar.hostId || draft.generationId !== registrar.generationId) throw new NativeProjectBootstrapError("repository draft does not match selected project and generation");
  const project = await new NativeProjectPendingStore(input.stateRoot).read(input.name, registrar.hostId);
  if (!project || project.projectId !== input.projectId) throw new NativeProjectBootstrapError("repository draft belongs to another project");
  return finishDraft(input.stateRoot, draft, store, registrar, importer, input.signal);
}
async function bootstrapClients(input: Pick<NativeProjectBootstrapInput, "registrarConnectionFile" | "importerConnectionFile" | "signal" | "selectedControlPlane">) {
  const registrarConnection = await loadNativeGitProjectRegistrarConnection(input.registrarConnectionFile);
  const importerConnection = await loadNativeGitRootImporterConnection(input.importerConnectionFile);
  if (registrarConnection.endpoint !== importerConnection.endpoint
    || registrarConnection.hostId !== importerConnection.hostId
    || registrarConnection.generationId !== importerConnection.generationId
    || registrarConnection.credential.username === importerConnection.credential.username
    || registrarConnection.credential.password === importerConnection.credential.password) {
    throw new NativeProjectBootstrapError("native Project bootstrap connections do not bind one distinct service and host generation");
  }
  const selected = input.selectedControlPlane;
  if (selected && (registrarConnection.endpoint !== selected.endpoint || registrarConnection.hostId !== selected.hostId || registrarConnection.generationId !== selected.generationId)) throw new NativeProjectBootstrapError("native Project bootstrap conflicts with the selected control-plane generation");
  const registrar = createNativeGitProjectRegistrarClient(
    registrarConnection, createNodeNativeGitAdmissionHttpClient()
  );
  const importer = createNativeGitRootImporterClient(importerConnection);
  await registrar.attest(input.signal);
  await importer.attest(input.signal);
  return { registrar, importer };
}
async function finishDraft(stateRoot: string, draft: NativeProjectDraft, store: NativeProjectDraftStore, registrar: NativeGitProjectRegistrarClient, importer: NativeGitRootImporterClient, signal: AbortSignal): Promise<NativeProjectDraft> {
  if (draft.phase === "repository-imported") {
    await requireLiveImportedRoot(importer, { draft, receipt: draft.importReceipt }, signal);
    return draft;
  }
  await registrar.prepare({ serviceId: "native-main", projectId: draft.projectId,
    repositoryId: draft.repositoryId }, signal);
  const bundlePath = join(stateRoot, "native-project-drafts", "artifacts", draft.projectId, draft.repositoryId,
    `${draft.bundleDigest}.bundle`);
  const receipt = await importer.importRepository({ serviceId: "native-main", projectId: draft.projectId,
    repositoryId: draft.repositoryId, protectedRef: draft.protectedRef,
    expectedCommit: draft.expectedCommit, policy: draft.repositoryPolicy, bundlePath }, signal);
  await requireLiveImportedRoot(importer, { draft, receipt }, signal);
  return store.markRepositoryImported(draft.name, draft.repositoryId, receipt);
}

async function requireLiveImportedRoot(importer: NativeGitRootImporterClient,
  expected: { readonly draft: NativeProjectDraft; readonly receipt: NativeGitRootImportResult },
  signal: AbortSignal): Promise<void> {
  let proof;
  try {
    proof = await importer.proveRepository(expected.draft.projectId, expected.draft.repositoryId, signal);
  } catch (error) {
    throw new NativeProjectBootstrapError("native Project imported root proof is unavailable", { cause: error });
  }
  if (proof.ownerHostId !== expected.draft.ownerHostId
    || !isDeepStrictEqual(proof.importReceipt, expected.receipt)) {
    throw new NativeProjectBootstrapError("native Project imported root proof conflicts with the draft");
  }
}
