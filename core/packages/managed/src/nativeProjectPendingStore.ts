import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { UserError } from "@slop-lab/dim-core";
import { LifecycleState } from "./lifecycleState.js";
import type { NativeGitImportedRootProof,
  NativeGitRootImporterClient } from "./nativeGitRootImporterClient.js";
import { parseNativeProjectPendingRecord,
  type NativeProjectPendingRecord, type NativeProjectReadyRecord,
  type NativeProjectRecord } from "./nativeProjectPendingCodec.js";
import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";
import { replaceNativeProjectRecord } from "./nativeProjectReadyFiles.js";
import { materializeNativeProjectReadinessRoot } from "./nativeProjectRootSelection.js";
import { assertNativeProjectRootSnapshotTree } from "./nativeProjectRootSnapshotTreeHash.js";
import { NativeProjectPendingFileError, publishNativeProjectPending,
  readNativeProjectPending, recoverNativeProjectPendingPublication } from "./nativeProjectPendingFiles.js";
import type { NativeProjectDraft } from "./nativeProjectDraftCodec.js";
import { NativeProjectDraftStore } from "./nativeProjectDraftStore.js";

type ImportedDraft = Extract<NativeProjectDraft, {
  readonly schemaVersion: 2;
  readonly phase: "root-imported";
}>;

export class NativeProjectPendingStoreError extends UserError {
  readonly name = "NativeProjectPendingStoreError";
}

export class NativeProjectPendingStore {
  readonly #state: LifecycleState;
  readonly #drafts: NativeProjectDraftStore;

  constructor(readonly root: string) {
    this.#state = new LifecycleState(root);
    this.#drafts = new NativeProjectDraftStore(root);
  }

  async read(name: string, ownerHostId: string): Promise<NativeProjectRecord | undefined> {
    try {
      const stored = await readNativeProjectPending(this.root, this.#state.projectPath(name));
      if (stored === undefined) return undefined;
      this.#assertSelectedRecord(stored.record, name, ownerHostId);
      return stored.record;
    } catch (error) {
      if (error instanceof NativeProjectPendingStoreError) throw error;
      throw new NativeProjectPendingStoreError("native Project admission-pending state cannot be read", {
        cause: error
      });
    }
  }

  async list(ownerHostId: string): Promise<readonly NativeProjectRecord[]> {
    const directory = join(this.root, "projects");
    try {
      await readNativeProjectPending(this.root, this.#state.projectPath("native-list-probe"));
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
      const names = entries.map((entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          throw new NativeProjectPendingStoreError("unsupported native Project state node exists");
        }
        const name = entry.name.slice(0, -".json".length);
        if (basename(this.#state.projectPath(name)) !== entry.name) {
          throw new NativeProjectPendingStoreError("native Project state path is invalid");
        }
        return name;
      }).sort((left, right) => left.localeCompare(right));
      const records: NativeProjectRecord[] = [];
      for (const name of names) {
        const record = await this.read(name, ownerHostId);
        if (record === undefined) {
          throw new NativeProjectPendingStoreError("native Project state changed during listing");
        }
        records.push(record);
      }
      return records;
    } catch (error) {
      if (error instanceof NativeProjectPendingStoreError) throw error;
      throw new NativeProjectPendingStoreError("native Project admission-pending state cannot be listed", {
        cause: error
      });
    }
  }

  async admit(
    name: string,
    importer: NativeGitRootImporterClient,
    signal: AbortSignal
  ): Promise<NativeProjectRecord> {
    signal.throwIfAborted();
    const release = await this.#state.acquireProjectLock(name);
    try {
      const draft = await this.#readImportedDraft(name);
      const target = this.#state.projectPath(name);
      if (importer.hostId !== draft.ownerHostId) {
        throw new NativeProjectPendingStoreError("native Project importer owner conflicts with the draft");
      }
      let proof: NativeGitImportedRootProof;
      try {
        proof = await importer.proveRoot(draft.projectId, signal);
      } catch (error) {
        throw new NativeProjectPendingStoreError("native Project imported root proof is unavailable", {
          cause: error
        });
      }
      const candidate = this.#candidate(draft, importer, proof);
      const bytes = Buffer.from(`${JSON.stringify(candidate)}\n`, "utf8");
      await recoverNativeProjectPendingPublication(this.root, target, bytes);
      const existing = await readNativeProjectPending(this.root, target);
      if (existing !== undefined) {
        if (existing.record.phase === "ready"
          && isDeepStrictEqual(pendingProjection(existing.record), candidate)) return existing.record;
        if (!existing.bytes.equals(bytes)) {
          throw new NativeProjectPendingStoreError("canonical Project replay conflicts with admission intent");
        }
        return existing.record;
      }
      await publishNativeProjectPending(this.root, target, bytes);
      return candidate;
    } catch (error) {
      if (error instanceof NativeProjectPendingStoreError) throw error;
      if (error instanceof NativeProjectPendingFileError) {
        throw new NativeProjectPendingStoreError(error.message, { cause: error });
      }
      throw new NativeProjectPendingStoreError("native Project admission-pending publication failed", {
        cause: error
      });
    } finally {
      await release();
    }
  }

  async ready(
    name: string,
    connection: NativeControlPlaneConnection,
    signal: AbortSignal
  ): Promise<NativeProjectReadyRecord> {
    const release = await this.#state.acquireProjectLock(name);
    try {
      const target = this.#state.projectPath(name);
      const stored = await readNativeProjectPending(this.root, target);
      if (stored === undefined) throw new NativeProjectPendingStoreError("native Project admission-pending state is missing");
      this.#assertSelectedRecord(stored.record, name, connection.hostId);
      const proof = await proveNativeProjectReadiness(connection, stored.record, signal,
        stored.record.phase === "ready"
          ? { commit: stored.record.rootCommit, tree: stored.record.rootTree, allowFastForward: true }
          : undefined);
      if (stored.record.phase === "ready") {
        await assertNativeProjectRootSnapshotTree(
          join(this.root, "assets", "native-project-roots", stored.record.projectId, stored.record.rootCommit),
          stored.record.rootTree
        );
        return stored.record;
      }
      await materializeNativeProjectReadinessRoot({
        stateRoot: this.root, connection, project: { ...stored.record,
          schemaVersion: 6, phase: "ready", readyAt: new Date().toISOString() },
        proof, signal
      });
      const ready = parseNativeProjectPendingRecord({
        ...stored.record,
        rootCommit: proof.commit,
        rootTree: proof.tree,
        schemaVersion: 6,
        phase: "ready",
        readyAt: new Date().toISOString()
      });
      if (ready.phase !== "ready") throw new NativeProjectPendingStoreError("native Project ready record is invalid");
      const bytes = Buffer.from(`${JSON.stringify(ready)}\n`, "utf8");
      await replaceNativeProjectRecord(target, stored.bytes, bytes);
      return ready;
    } catch (error) {
      if (error instanceof NativeProjectPendingStoreError) throw error;
      throw new NativeProjectPendingStoreError("native Project ready publication failed", { cause: error });
    } finally {
      await release();
    }
  }

  async #readImportedDraft(name: string): Promise<ImportedDraft> {
    const draft = await this.#drafts.read(name);
    if (draft === undefined || draft.schemaVersion !== 2 || draft.phase !== "root-imported") {
      throw new NativeProjectPendingStoreError("native Project requires a current imported-root draft");
    }
    return draft;
  }

  #candidate(
    draft: ImportedDraft,
    importer: NativeGitRootImporterClient,
    proof: NativeGitImportedRootProof
  ): NativeProjectPendingRecord {
    const policyDigest = createHash("sha256").update(JSON.stringify(draft.reviewPolicy)).digest("hex");
    if (proof.schemaVersion !== 3 || proof.servingGenerationId !== importer.generationId
      || proof.ownerHostId !== draft.ownerHostId
      || !isDeepStrictEqual(proof.importReceipt, draft.importReceipt)
      || proof.currentHead.projectId !== draft.projectId || proof.currentHead.sequence !== 0
      || proof.currentHead.protectedRef !== draft.protectedRef
      || proof.currentHead.commit !== draft.expectedCommit || proof.currentHead.tree !== draft.expectedTree
      || proof.currentHead.policyDigest !== policyDigest) {
      throw new NativeProjectPendingStoreError("native Project imported root proof conflicts with the draft");
    }
    const candidate = parseNativeProjectPendingRecord({
      schemaVersion: 5,
      recordType: "native-project",
      phase: "admission-pending",
      name: draft.name,
      projectId: draft.projectId,
      serviceId: draft.serviceId,
      ownerHostId: draft.ownerHostId,
      rootRepositoryId: draft.rootRepositoryId,
      rootAlias: draft.rootAlias,
      protectedRef: draft.protectedRef,
      rootCommit: draft.expectedCommit,
      rootTree: draft.expectedTree,
      reviewPolicy: draft.reviewPolicy,
      bundleDigest: draft.bundleDigest,
      bundleSize: draft.bundleSize,
      importReceipt: draft.importReceipt
    });
    if (candidate.phase !== "admission-pending") {
      throw new NativeProjectPendingStoreError("native Project pending record is invalid");
    }
    return candidate;
  }

  #assertSelectedRecord(record: NativeProjectRecord, name: string, ownerHostId: string): void {
    if (record.name !== name) {
      throw new NativeProjectPendingStoreError("native Project record name conflicts with its path");
    }
    if (record.ownerHostId !== ownerHostId) {
      throw new NativeProjectPendingStoreError("native Project belongs to another native host");
    }
  }
}

function pendingProjection(record: NativeProjectReadyRecord): NativeProjectPendingRecord {
  const { readyAt: _readyAt, ...common } = record;
  return { ...common, schemaVersion: 5, phase: "admission-pending" };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
