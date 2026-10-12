import { UserError } from "./errors.js";
import type { NativeGitRootImportResult } from "./nativeGitRootImporterClient.js";
import { parseNativeProjectDraft } from "./nativeProjectDraftCodec.js";
import type { NativeRootBootstrapPolicy } from "./nativeRootBootstrapPolicy.js";

const fields = ["schemaVersion", "recordType", "phase", "name", "projectId", "serviceId",
  "ownerHostId", "rootRepositoryId", "rootAlias", "protectedRef", "rootCommit", "rootTree",
  "reviewPolicy", "bundleDigest", "bundleSize", "importReceipt"] as const;

export type NativeProjectPendingRecord = {
  readonly schemaVersion: 5;
  readonly recordType: "native-project";
  readonly phase: "admission-pending";
  readonly name: string;
  readonly projectId: string;
  readonly serviceId: "native-main";
  readonly ownerHostId: string;
  readonly rootRepositoryId: "root";
  readonly rootAlias: string;
  readonly protectedRef: string;
  readonly rootCommit: string;
  readonly rootTree: string;
  readonly reviewPolicy: NativeRootBootstrapPolicy["reviewPolicy"];
  readonly bundleDigest: string;
  readonly bundleSize: number;
  readonly importReceipt: NativeGitRootImportResult;
};

export type NativeProjectReadyRecord = Omit<NativeProjectPendingRecord, "schemaVersion" | "phase"> & {
  readonly schemaVersion: 6;
  readonly phase: "ready";
  readonly readyAt: string;
};

export type NativeProjectRecord = NativeProjectPendingRecord | NativeProjectReadyRecord;

export class NativeProjectPendingRecordError extends UserError {
  readonly name = "NativeProjectPendingRecordError";
}

export function parseNativeProjectPendingRecord(input: unknown): NativeProjectRecord {
  const record = exactRecord(input);
  const pending = record.schemaVersion === 5 && record.phase === "admission-pending";
  const ready = record.schemaVersion === 6 && record.phase === "ready"
    && typeof record.readyAt === "string" && new Date(record.readyAt).toISOString() === record.readyAt;
  if ((!pending && !ready) || record.recordType !== "native-project") invalid();
  try {
    const draft = parseNativeProjectDraft({
      schemaVersion: 2,
      recordType: "native-project-draft",
      phase: "root-imported",
      name: record.name,
      projectId: record.projectId,
      serviceId: record.serviceId,
      ownerHostId: record.ownerHostId,
      generationId: receiptGeneration(record.importReceipt),
      rootRepositoryId: record.rootRepositoryId,
      rootAlias: record.rootAlias,
      protectedRef: record.protectedRef,
      expectedCommit: record.rootCommit,
      expectedTree: record.rootTree,
      reviewPolicy: record.reviewPolicy,
      bundleDigest: record.bundleDigest,
      bundleSize: record.bundleSize,
      importReceipt: record.importReceipt
    });
    if (draft.schemaVersion !== 2 || draft.phase !== "root-imported") invalid();
    const common = {
      recordType: "native-project" as const,
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
    };
    if (ready) {
      if (typeof record.readyAt !== "string") invalid();
      return { ...common, schemaVersion: 6, phase: "ready", readyAt: record.readyAt };
    }
    return { ...common, schemaVersion: 5, phase: "admission-pending" };
  } catch (error) {
    if (error instanceof NativeProjectPendingRecordError) throw error;
    throw new NativeProjectPendingRecordError("native Project admission-pending record is invalid", {
      cause: error
    });
  }
}

function exactRecord(input: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(input)
    || (Object.keys(input).length !== fields.length && Object.keys(input).length !== fields.length + 1)
    || fields.some((field) => !Object.hasOwn(input, field))
    || (Object.keys(input).length === fields.length + 1 && !Object.hasOwn(input, "readyAt"))) invalid();
  return input;
}

function isRecord(input: unknown): input is Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function receiptGeneration(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid();
  return Reflect.get(input, "generationId");
}

function invalid(): never {
  throw new NativeProjectPendingRecordError("native Project admission-pending record is invalid");
}
