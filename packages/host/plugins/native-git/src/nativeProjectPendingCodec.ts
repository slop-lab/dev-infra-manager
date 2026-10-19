import { UserError, validateLifecycleName } from "@slop-lab/dim-host-core";
import { parseNativeProjectDraft } from "./nativeProjectDraftCodec.js";
import type { NativeGitRootImportResult } from "./nativeGitRootImporterClient.js";
import type { NativeRepositoryBootstrapPolicy } from "./nativeRootBootstrapPolicy.js";

export interface NativeProjectRepositoryRecord {
  readonly repositoryId: string;
  readonly phase: "ready";
  readonly protectedRef: string;
  readonly commit: string;
  readonly tree: string;
  readonly reviewPolicy: NativeRepositoryBootstrapPolicy["reviewPolicy"];
  readonly importReceipt: NativeGitRootImportResult;
  readonly bundleDigest: string;
  readonly bundleSize: number;
  readonly readyAt: string;
}
interface ProjectIdentity {
  readonly schemaVersion: 7;
  readonly recordType: "native-project";
  readonly name: string;
  readonly projectId: string;
  readonly serviceId: "native-main";
  readonly ownerHostId: string;
  readonly repositories: Readonly<Record<string, NativeProjectRepositoryRecord>>;
}
export type NativeProjectPendingRecord = ProjectIdentity & {
  readonly phase: "configuring";
  readonly configurationRepositoryId: null;
  readonly defaultWorkingRepositoryId: null;
};
export type NativeProjectReadyRecord = ProjectIdentity & {
  readonly phase: "ready";
  readonly configurationRepositoryId: string;
  readonly defaultWorkingRepositoryId: string;
  readonly readyAt: string;
};
export type NativeProjectRecord = NativeProjectPendingRecord | NativeProjectReadyRecord;
export class NativeProjectPendingRecordError extends UserError { readonly name = "NativeProjectPendingRecordError"; }

export function parseNativeProjectPendingRecord(input: unknown): NativeProjectRecord {
  try {
    const value = object(input);
    const fields = ["schemaVersion", "recordType", "phase", "name", "projectId", "serviceId", "ownerHostId", "configurationRepositoryId", "defaultWorkingRepositoryId", "repositories"];
    exact(value, value.phase === "ready" ? [...fields, "readyAt"] : fields);
    if (value.schemaVersion !== 7 || value.recordType !== "native-project" || value.serviceId !== "native-main"
      || typeof value.name !== "string" || typeof value.projectId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value.projectId)
      || typeof value.ownerHostId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.ownerHostId)) invalid();
    const name = validateLifecycleName(value.name, "project"), entries = object(value.repositories);
    if (Object.keys(entries).length > 64) invalid();
    const repositories: Record<string, NativeProjectRepositoryRecord> = {};
    for (const [repositoryId, entry] of Object.entries(entries)) {
      const repository = object(entry);
      exact(repository, ["repositoryId", "phase", "protectedRef", "commit", "tree", "reviewPolicy", "importReceipt", "bundleDigest", "bundleSize", "readyAt"]);
      if (repository.repositoryId !== repositoryId || repository.phase !== "ready" || !timestamp(repository.readyAt)) invalid();
      const receipt = object(repository.importReceipt);
      const draft = parseNativeProjectDraft({ schemaVersion: 3, recordType: "native-project-draft", phase: "repository-imported",
        name, projectId: value.projectId, serviceId: "native-main", ownerHostId: value.ownerHostId,
        generationId: receipt.generationId, repositoryId, protectedRef: repository.protectedRef,
        expectedCommit: repository.commit, expectedTree: repository.tree, reviewPolicy: repository.reviewPolicy,
        bundleDigest: repository.bundleDigest, bundleSize: repository.bundleSize, importReceipt: repository.importReceipt });
      if (draft.phase !== "repository-imported") invalid();
      repositories[repositoryId] = { repositoryId, phase: "ready", protectedRef: draft.protectedRef, commit: draft.expectedCommit, tree: draft.expectedTree,
        reviewPolicy: draft.reviewPolicy, importReceipt: draft.importReceipt, bundleDigest: draft.bundleDigest, bundleSize: draft.bundleSize, readyAt: repository.readyAt };
    }
    const common: ProjectIdentity = { schemaVersion: 7, recordType: "native-project", name, projectId: value.projectId,
      serviceId: "native-main", ownerHostId: value.ownerHostId, repositories };
    if (value.phase === "configuring" && value.configurationRepositoryId === null && value.defaultWorkingRepositoryId === null) {
      return { ...common, phase: "configuring", configurationRepositoryId: null, defaultWorkingRepositoryId: null };
    }
    if (value.phase !== "ready" || typeof value.configurationRepositoryId !== "string" || typeof value.defaultWorkingRepositoryId !== "string"
      || !Object.hasOwn(repositories, value.configurationRepositoryId) || !Object.hasOwn(repositories, value.defaultWorkingRepositoryId) || !timestamp(value.readyAt)) invalid();
    return { ...common, phase: "ready", configurationRepositoryId: value.configurationRepositoryId,
      defaultWorkingRepositoryId: value.defaultWorkingRepositoryId, readyAt: value.readyAt };
  } catch (error) {
    if (error instanceof NativeProjectPendingRecordError) throw error;
    throw new NativeProjectPendingRecordError("native Project repository catalog is invalid", { cause: error });
  }
}
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, fields: readonly string[]): void { if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) invalid(); }
function timestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function invalid(): never { throw new NativeProjectPendingRecordError("native Project repository catalog is invalid"); }
