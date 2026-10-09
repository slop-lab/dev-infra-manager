import { isDeepStrictEqual } from "node:util";
import { UserError } from "./errors.js";
import { createNativeGitRootImporterClient } from "./nativeGitRootImporterClient.js";
import { loadNativeGitRootImporterConnection } from "./nativeGitRootImporterConnection.js";
import { createNativeGitRootReadIssuerClient,
  type NativeGitRootReadLease } from "./nativeGitRootReadIssuerClient.js";
import { loadNativeGitRootReadIssuerConnection } from "./nativeGitRootReadIssuerConnection.js";
import { NativeProjectDraftStore } from "./nativeProjectDraftStore.js";
import type { NativeProjectDraft } from "./nativeProjectDraftCodec.js";

export type NativeProjectDraftRootReadInput = {
  readonly stateRoot: string;
  readonly name: string;
  readonly importerConnectionFile: string;
  readonly issuerConnectionFile: string;
  readonly signal: AbortSignal;
};

export class NativeProjectDraftRootReadError extends UserError {
  readonly name = "NativeProjectDraftRootReadError";
}

export type ValidatedNativeProjectDraftRootRead = {
  readonly draft: Extract<NativeProjectDraft, { readonly phase: "root-imported" }>;
  readonly serviceEndpoint: string;
  readonly currentHeadCommit: string;
};

export async function issueNativeProjectDraftRootReadLease(
  input: NativeProjectDraftRootReadInput
): Promise<NativeGitRootReadLease> {
  try {
    const validated = await validateNativeProjectDraftRootRead(input);
    const issuerConnection = await loadNativeGitRootReadIssuerConnection(input.issuerConnectionFile);
    const issuer = createNativeGitRootReadIssuerClient(issuerConnection);
    const lease = await issuer.issueRootReadLease(validated.draft.projectId, input.signal);
    const store = new NativeProjectDraftStore(input.stateRoot);
    const current = await store.read(input.name);
    if (!isDeepStrictEqual(current, validated.draft)) {
      throw new NativeProjectDraftRootReadError("native Project draft changed while issuing the root read lease");
    }
    return lease;
  } catch (error) {
    if (error instanceof NativeProjectDraftRootReadError) throw error;
    throw new NativeProjectDraftRootReadError("native Project root read lease could not be issued");
  }
}

export async function validateNativeProjectDraftRootRead(
  input: NativeProjectDraftRootReadInput
): Promise<ValidatedNativeProjectDraftRootRead> {
  input.signal.throwIfAborted();
  const [importerConnection, issuerConnection] = await Promise.all([
    loadNativeGitRootImporterConnection(input.importerConnectionFile),
    loadNativeGitRootReadIssuerConnection(input.issuerConnectionFile)
  ]);
  if (importerConnection.endpoint !== issuerConnection.endpoint
    || importerConnection.hostId !== issuerConnection.hostId
    || importerConnection.generationId !== issuerConnection.generationId
    || importerConnection.credential.username === issuerConnection.credential.username
    || importerConnection.credential.password === issuerConnection.credential.password) {
    throw new NativeProjectDraftRootReadError(
      "native Project root read connections do not bind one service and host generation with distinct credentials"
    );
  }
  const draft = await new NativeProjectDraftStore(input.stateRoot).read(input.name);
  if (draft === undefined || draft.phase !== "root-imported"
    || draft.serviceId !== importerConnection.serviceId
    || draft.ownerHostId !== importerConnection.hostId) {
    throw new NativeProjectDraftRootReadError("native Project draft is not an imported root owned by this host");
  }
  const proof = await createNativeGitRootImporterClient(importerConnection)
    .proveRoot(draft.projectId, input.signal);
  if (proof.ownerHostId !== draft.ownerHostId
    || !isDeepStrictEqual(proof.importReceipt, draft.importReceipt)) {
    throw new NativeProjectDraftRootReadError("native Project imported root proof conflicts with the draft");
  }
  return { draft, serviceEndpoint: importerConnection.endpoint,
    currentHeadCommit: proof.currentHead.commit };
}
