import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { UserError } from "./errors.js";
import { createNodeNativeGitAdmissionHttpClient } from "./nativeGitAdmissionHttpClient.js";
import { createNativeGitProjectRegistrarClient } from "./nativeGitProjectRegistrarClient.js";
import { loadNativeGitProjectRegistrarConnection } from "./nativeGitProjectRegistrarConnection.js";
import { createNativeGitRootImporterClient,
  type NativeGitRootImporterClient, type NativeGitRootImportResult } from "./nativeGitRootImporterClient.js";
import { loadNativeGitRootImporterConnection } from "./nativeGitRootImporterConnection.js";
import type { NativeProjectDraft } from "./nativeProjectDraftCodec.js";
import { NativeProjectDraftStore } from "./nativeProjectDraftStore.js";
import { prepareNativeRootBootstrapGit, type NativeRootBootstrapGitInput } from "./nativeRootBootstrapGit.js";

export type NativeProjectBootstrapInput = NativeRootBootstrapGitInput & {
  readonly name: string;
  readonly projectId: string;
  readonly stateRoot: string;
  readonly registrarConnectionFile: string;
  readonly importerConnectionFile: string;
};

export class NativeProjectBootstrapError extends UserError {
  readonly name = "NativeProjectBootstrapError";
}

export async function bootstrapNativeProjectRoot(input: NativeProjectBootstrapInput): Promise<NativeProjectDraft> {
  input.signal.throwIfAborted();
  const registrarConnection = await loadNativeGitProjectRegistrarConnection(input.registrarConnectionFile);
  const importerConnection = await loadNativeGitRootImporterConnection(input.importerConnectionFile);
  if (registrarConnection.endpoint !== importerConnection.endpoint
    || registrarConnection.hostId !== importerConnection.hostId
    || registrarConnection.generationId !== importerConnection.generationId
    || registrarConnection.credential.username === importerConnection.credential.username
    || registrarConnection.credential.password === importerConnection.credential.password) {
    throw new NativeProjectBootstrapError("native Project bootstrap connections do not bind one distinct service and host generation");
  }
  const registrar = createNativeGitProjectRegistrarClient(
    registrarConnection, createNodeNativeGitAdmissionHttpClient()
  );
  const importer = createNativeGitRootImporterClient(importerConnection);
  await registrar.attest(input.signal);
  await importer.attest(input.signal);
  const plan = await prepareNativeRootBootstrapGit(input);
  try {
    const store = new NativeProjectDraftStore(input.stateRoot);
    const draft = await store.claim({ name: input.name, projectId: input.projectId,
      ownerHostId: registrar.hostId, generationId: registrar.generationId,
      rootAlias: plan.rootAlias, protectedRef: plan.protectedRef,
      expectedCommit: plan.expectedCommit, expectedTree: plan.resolvedTree,
      reviewPolicy: plan.reviewPolicy,
      bundlePath: plan.bundlePath });
    if (draft.phase === "root-imported") {
      await requireLiveImportedRoot(importer, { draft, receipt: draft.importReceipt }, input.signal);
      return draft;
    }
    await registrar.prepare({ serviceId: "native-main", projectId: draft.projectId,
      rootRepositoryId: "root" }, input.signal);
    const bundlePath = join(input.stateRoot, "native-project-drafts", "artifacts", draft.projectId,
      `${draft.bundleDigest}.bundle`);
    const receipt = await importer.importRoot({ serviceId: "native-main", projectId: draft.projectId,
      rootRepositoryId: "root", protectedRef: draft.protectedRef,
      expectedCommit: draft.expectedCommit, policy: draft.reviewPolicy, bundlePath }, input.signal);
    await requireLiveImportedRoot(importer, { draft, receipt }, input.signal);
    return store.markRootImported(draft.name, receipt);
  } finally {
    await plan.cleanup();
  }
}

async function requireLiveImportedRoot(importer: NativeGitRootImporterClient,
  expected: { readonly draft: NativeProjectDraft; readonly receipt: NativeGitRootImportResult },
  signal: AbortSignal): Promise<void> {
  let proof;
  try {
    proof = await importer.proveRoot(expected.draft.projectId, signal);
  } catch (error) {
    throw new NativeProjectBootstrapError("native Project imported root proof is unavailable", { cause: error });
  }
  if (proof.ownerHostId !== expected.draft.ownerHostId
    || !isDeepStrictEqual(proof.importReceipt, expected.receipt)) {
    throw new NativeProjectBootstrapError("native Project imported root proof conflicts with the draft");
  }
}
