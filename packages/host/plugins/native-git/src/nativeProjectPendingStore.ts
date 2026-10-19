import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acquireLifecycleLock, UserError } from "@slop-lab/dim-host-core";
import { NativeProjectState } from "./nativeProjectState.js";
import { parseNativeProjectPendingRecord, type NativeProjectRecord, type NativeProjectReadyRecord } from "./nativeProjectPendingCodec.js";
import { NativeProjectDraftStore } from "./nativeProjectDraftStore.js";
import { readNativeProjectPending, publishNativeProjectPending, recoverNativeProjectPendingPublication } from "./nativeProjectPendingFiles.js";
import { replaceNativeProjectRecord } from "./nativeProjectReadyFiles.js";
import type { NativeGitRootImporterClient } from "./nativeGitRootImporterClient.js";
import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";

export class NativeProjectPendingStoreError extends UserError { readonly name = "NativeProjectPendingStoreError"; }
/** Host-local Project catalog; imports and their durable drafts are independent per repository. */
export class NativeProjectPendingStore {
  readonly #state: NativeProjectState;
  constructor(readonly root: string) { this.#state = new NativeProjectState(root); }
  async read(name: string, ownerHostId: string): Promise<NativeProjectRecord | undefined> {
    try { await lstat(this.root); } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
    const stored = await readNativeProjectPending(this.root, this.#state.projectPath(name));
    if (!stored) return undefined;
    if (stored.record.name !== name || stored.record.ownerHostId !== ownerHostId) throw new NativeProjectPendingStoreError("Project identity conflicts with the selected host");
    return stored.record;
  }
  async list(ownerHostId: string): Promise<readonly NativeProjectRecord[]> {
    try { await lstat(this.root); } catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
    await readNativeProjectPending(this.root, this.#state.projectPath("catalog-validation-probe"));
    const entries = await readdir(join(this.root, "projects"), { withFileTypes: true }).catch((error: unknown) => { if (hasCode(error, "ENOENT")) return []; throw error; });
    const records: NativeProjectRecord[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) throw new NativeProjectPendingStoreError("unsupported Project state node");
      const record = await this.read(entry.name.slice(0, -5), ownerHostId);
      if (!record) throw new NativeProjectPendingStoreError("Project state changed during listing");
      records.push(record);
    }
    return records;
  }
  async create(input: { name: string; projectId: string; ownerHostId: string }): Promise<NativeProjectRecord> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const release = await acquireLifecycleLock({ root: this.root, name: "native-project-catalog", description: "Project creation" });
    try {
      const record = parseNativeProjectPendingRecord({ schemaVersion: 7, recordType: "native-project", name: input.name,
        projectId: input.projectId, serviceId: "native-main", ownerHostId: input.ownerHostId, phase: "configuring",
        configurationRepositoryId: null, defaultWorkingRepositoryId: null, repositories: {} });
      await recoverNativeProjectPendingPublication(this.root, this.#state.projectPath(input.name), Buffer.from(`${JSON.stringify(record)}\n`));
      const existing = await this.read(input.name, input.ownerHostId);
      if (existing) {
        if (existing.projectId !== input.projectId) throw new NativeProjectPendingStoreError("Project replay changes its identity");
        return existing;
      }
      if ((await this.list(input.ownerHostId)).some((entry) => entry.projectId === input.projectId)) throw new NativeProjectPendingStoreError("Project ID already belongs to another name");
      await publishNativeProjectPending(this.root, this.#state.projectPath(input.name), Buffer.from(`${JSON.stringify(record)}\n`));
      return record;
    } finally { await release(); }
  }
  async admitRepository(name: string, repositoryId: string, importer: NativeGitRootImporterClient,
    connection: NativeControlPlaneConnection, signal: AbortSignal): Promise<NativeProjectRecord> {
    const draft = await new NativeProjectDraftStore(this.root).read(name, repositoryId);
    if (!draft || draft.phase !== "repository-imported") throw new NativeProjectPendingStoreError("repository import has not completed");
    const proof = await importer.proveRepository(draft.projectId, repositoryId, signal);
    if (draft.ownerHostId !== connection.hostId || importer.hostId !== connection.hostId || !isDeepStrictEqual(proof.importReceipt, draft.importReceipt)) {
      throw new NativeProjectPendingStoreError("repository import proof conflicts with its draft or selected host");
    }
    const release = await this.#state.acquireProjectLock(name);
    try {
      const current = await this.read(name, connection.hostId);
      if (!current || current.projectId !== draft.projectId) throw new NativeProjectPendingStoreError("repository import belongs to another Project");
      const candidate = { repositoryId, phase: "ready", protectedRef: draft.protectedRef, commit: draft.expectedCommit, tree: draft.expectedTree,
        reviewPolicy: draft.reviewPolicy, importReceipt: draft.importReceipt, bundleDigest: draft.bundleDigest, bundleSize: draft.bundleSize,
        readyAt: current.repositories[repositoryId]?.readyAt ?? new Date().toISOString() };
      const existing = current.repositories[repositoryId];
      if (existing && !isDeepStrictEqual(existing, candidate)) throw new NativeProjectPendingStoreError("repository replay changes immutable import intent");
      const updated = parseNativeProjectPendingRecord({ ...current, repositories: { ...current.repositories, [repositoryId]: candidate } });
      await proveNativeProjectReadiness(connection, updated, repositoryId, signal);
      await this.replace(current, updated);
      return updated;
    } finally { await release(); }
  }
  async configure(name: string, selection: { configurationRepositoryId: string; defaultWorkingRepositoryId: string },
    connection: NativeControlPlaneConnection, signal: AbortSignal): Promise<NativeProjectReadyRecord> {
    const release = await this.#state.acquireProjectLock(name);
    try {
      const current = await this.read(name, connection.hostId);
      if (!current) throw new NativeProjectPendingStoreError("Project does not exist");
      for (const repositoryId of new Set(Object.values(selection))) await proveNativeProjectReadiness(connection, current, repositoryId, signal);
      const updated = parseNativeProjectPendingRecord({ ...current, ...selection, phase: "ready", readyAt: new Date().toISOString() });
      if (updated.phase !== "ready") throw new NativeProjectPendingStoreError("Project defaults are invalid");
      await this.replace(current, updated);
      return updated;
    } finally { await release(); }
  }
  private async replace(current: NativeProjectRecord, updated: NativeProjectRecord): Promise<void> {
    await replaceNativeProjectRecord(this.#state.projectPath(current.name), Buffer.from(`${JSON.stringify(current)}\n`), Buffer.from(`${JSON.stringify(updated)}\n`));
  }
}
function hasCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
