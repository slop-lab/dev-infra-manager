import { parseAuthoritativeImportedRootPolicy, type NativeImportedRootPolicy } from "@slop-lab/dim-contracts-git";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { acquireLifecycleLock, UserError } from "@slop-lab/dim-host-core";
import { NativeProjectState } from "./nativeProjectState.js";
import { NativeProjectPendingRecordError, parseNativeProjectPendingRecord, type NativeProjectRecord, type NativeProjectReadyRecord } from "./nativeProjectPendingCodec.js";
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
  async attach(candidate: NativeProjectReadyRecord): Promise<NativeProjectReadyRecord> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const release = await acquireLifecycleLock({ root: this.root, name: "native-project-catalog", description: "Project attachment" });
    try {
      const bytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
      await recoverNativeProjectPendingPublication(this.root, this.#state.projectPath(candidate.name), (actualBytes) => {
        try {
          const value: unknown = JSON.parse(actualBytes.toString("utf8"));
          const recovered = parseNativeProjectPendingRecord(value);
          return recovered.phase === "ready" && recovered.name === candidate.name
            && recovered.ownerHostId === candidate.ownerHostId && recovered.projectId === candidate.projectId
            && recovered.configurationRepositoryId === candidate.configurationRepositoryId
            && recovered.defaultWorkingRepositoryId === candidate.defaultWorkingRepositoryId
            && sameAttachment(recovered, candidate);
        } catch (error) {
          if (error instanceof SyntaxError || error instanceof NativeProjectPendingRecordError) return false;
          throw error;
        }
      });
      const existing = await this.read(candidate.name, candidate.ownerHostId);
      if (existing) {
        const projectRelease = await this.#state.acquireProjectLock(candidate.name);
        try {
          const current = await this.read(candidate.name, candidate.ownerHostId);
          if (!current) throw new NativeProjectPendingStoreError("Project attachment changed during reconciliation");
          requireSameAttachmentIdentity(current, candidate);
          const updated = reconcileAttachmentPolicies(current, candidate);
          if (updated === current) return current;
          await this.replace(current, updated);
          return updated;
        } finally { await projectRelease(); }
      }
      if ((await this.list(candidate.ownerHostId)).some((entry) => entry.projectId === candidate.projectId)) {
        throw new NativeProjectPendingStoreError("Project ID already belongs to another local name");
      }
      await publishNativeProjectPending(this.root, this.#state.projectPath(candidate.name), bytes);
      return candidate;
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
        repositoryPolicy: draft.repositoryPolicy, importReceipt: draft.importReceipt, bundleDigest: draft.bundleDigest, bundleSize: draft.bundleSize,
        readyAt: current.repositories[repositoryId]?.readyAt ?? new Date().toISOString() };
      const existing = current.repositories[repositoryId];
      if (existing && !isDeepStrictEqual({ ...existing, repositoryPolicy: existing.importedPolicy ?? existing.repositoryPolicy, importedPolicy: undefined }, { ...candidate, importedPolicy: undefined })) throw new NativeProjectPendingStoreError("repository replay changes immutable import intent");
      const updated = parseNativeProjectPendingRecord({ ...current, repositories: { ...current.repositories, [repositoryId]: existing ?? candidate } });
      await proveNativeProjectReadiness(connection, updated, repositoryId, signal);
      await this.replace(current, updated);
      return updated;
    } finally { await release(); }
  }
  /** Update only effective policy; import receipts, bundles and selected snapshots remain immutable. */
  async applyRepositoryPolicy(name: string, repositoryId: string, input: NativeImportedRootPolicy,
    expectedPolicyRevision: string, connection: NativeControlPlaneConnection, signal: AbortSignal): Promise<NativeProjectRecord> {
    const policy = parseAuthoritativeImportedRootPolicy(input);
    const release = await this.#state.acquireProjectLock(name);
    try {
      const current = await this.read(name, connection.hostId);
      const repository = current?.repositories[repositoryId];
      if (!current || !repository) throw new NativeProjectPendingStoreError("Project repository does not exist");
      if (repository.protectedRef !== policy.protectedRef) throw new NativeProjectPendingStoreError("policy update cannot change the repository's protected ref");
      if (repository.repositoryPolicy.policyRevision !== expectedPolicyRevision
        && repository.repositoryPolicy.policyRevision !== policy.policyRevision) {
        throw new NativeProjectPendingStoreError("repository policy changed; refresh its current policy and retry");
      }
      const originalPolicy = repository.importedPolicy ?? repository.repositoryPolicy;
      const { importedPolicy: _importedPolicy, ...identity } = repository;
      const updated = parseNativeProjectPendingRecord({ ...current, repositories: { ...current.repositories,
        [repositoryId]: { ...identity, repositoryPolicy: policy,
          ...(isDeepStrictEqual(originalPolicy, policy) ? {} : { importedPolicy: originalPolicy }) } } });
      // An authenticated authority must confirm this policy and the original snapshot's
      // ancestry before local state changes. Updating policy never advances the checkout.
      await proveNativeProjectReadiness(connection, updated, repositoryId, signal, {
        commit: repository.commit, tree: repository.tree, allowFastForward: true
      });
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
function sameAttachment(existing: NativeProjectReadyRecord, candidate: NativeProjectReadyRecord): boolean {
  const existingIds = Object.keys(existing.repositories).sort();
  const candidateIds = Object.keys(candidate.repositories).sort();
  if (!isDeepStrictEqual(existingIds, candidateIds)) return false;
  return existingIds.every((repositoryId) => {
    const left = existing.repositories[repositoryId];
    const right = candidate.repositories[repositoryId];
    if (!left || !right) return false;
    return left.protectedRef === right.protectedRef && left.commit === right.commit && left.tree === right.tree
      && left.bundleDigest === right.bundleDigest && left.bundleSize === right.bundleSize
      && isDeepStrictEqual(left.importReceipt, right.importReceipt)
      && isDeepStrictEqual(left.importedPolicy ?? left.repositoryPolicy, right.importedPolicy ?? right.repositoryPolicy);
  });
}
function requireSameAttachmentIdentity(existing: NativeProjectRecord, candidate: NativeProjectReadyRecord): asserts existing is NativeProjectReadyRecord {
  if (existing.phase !== "ready" || existing.projectId !== candidate.projectId
    || existing.configurationRepositoryId !== candidate.configurationRepositoryId
    || existing.defaultWorkingRepositoryId !== candidate.defaultWorkingRepositoryId
    || !sameAttachment(existing, candidate)) {
    throw new NativeProjectPendingStoreError("Project attachment conflicts with existing local state");
  }
}
function reconcileAttachmentPolicies(existing: NativeProjectReadyRecord, candidate: NativeProjectReadyRecord): NativeProjectReadyRecord {
  let changed = false;
  const repositories = Object.fromEntries(Object.entries(existing.repositories).map(([repositoryId, repository]) => {
    const authoritative = candidate.repositories[repositoryId];
    if (!authoritative) throw new NativeProjectPendingStoreError("Project attachment repository set changed");
    const originalPolicy = repository.importedPolicy ?? repository.repositoryPolicy;
    const { importedPolicy: _importedPolicy, ...identity } = repository;
    const reconciled = {
      ...identity,
      repositoryPolicy: authoritative.repositoryPolicy,
      ...(isDeepStrictEqual(originalPolicy, authoritative.repositoryPolicy) ? {} : { importedPolicy: originalPolicy })
    };
    if (isDeepStrictEqual(repository, reconciled)) return [repositoryId, repository];
    changed = true;
    return [repositoryId, reconciled];
  }));
  if (!changed) return existing;
  const updated = parseNativeProjectPendingRecord({ ...existing, repositories });
  if (updated.phase !== "ready") throw new NativeProjectPendingStoreError("Project attachment policy reconciliation is invalid");
  return updated;
}
