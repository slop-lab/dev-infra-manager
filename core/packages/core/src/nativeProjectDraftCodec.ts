import { createHash } from "node:crypto";
import { UserError } from "./errors.js";
import type { NativeGitRootImportResult } from "./nativeGitRootImporterClient.js";
import { compileNativeRootBootstrapPolicy, type NativeRootBootstrapPolicy } from "./nativeRootBootstrapPolicy.js";
import { validateLifecycleName } from "./lifecycleRecord.js";

const commonFields = ["recordType", "phase", "name", "projectId", "serviceId", "ownerHostId", "generationId",
  "rootRepositoryId", "rootAlias", "protectedRef", "expectedCommit", "expectedTree", "reviewPolicy",
  "bundleDigest", "bundleSize"] as const;
const modernFields = ["schemaVersion", ...commonFields] as const;
const legacyFields = ["schemaVersion", ...commonFields, "requiredJobs", "importReceipt"] as const;
const receiptFields = ["schemaVersion", "serviceId", "projectId", "rootRepositoryId", "generationId",
  "importNonce", "protectedRef", "expectedCommit", "policyDigest", "bundleDigest", "bundleSize",
  "resolvedTree", "phase"] as const;
const digestPattern = /^[0-9a-f]{64}$/;
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type ModernDraftBase = DraftIdentity & {
  readonly schemaVersion: 2;
  readonly reviewPolicy: NativeRootBootstrapPolicy["reviewPolicy"];
};
type LegacyRequiredJob = { readonly name: string; readonly kind: "ordinary-sysbox" | "qemu" };
type LegacyReviewPolicy = {
  readonly protectedRef: string;
  readonly policyRevision: string;
  readonly requiredReviewRevision: string;
  readonly requiredJobSetRevision: string;
  readonly requiredJobNames: readonly string[];
  readonly requiredReviewerIds: readonly string[];
  readonly pathReviewerRules: NativeRootBootstrapPolicy["reviewPolicy"]["pathReviewerRules"];
};
type LegacyImportedDraft = DraftIdentity & {
  readonly schemaVersion: 1;
  readonly phase: "root-imported";
  readonly requiredJobs: readonly LegacyRequiredJob[];
  readonly reviewPolicy: LegacyReviewPolicy;
  readonly importReceipt: NativeGitRootImportResult;
};
type DraftIdentity = {
  readonly recordType: "native-project-draft";
  readonly name: string;
  readonly projectId: string;
  readonly serviceId: "native-main";
  readonly ownerHostId: string;
  readonly generationId: string;
  readonly rootRepositoryId: "root";
  readonly rootAlias: string;
  readonly protectedRef: string;
  readonly expectedCommit: string;
  readonly expectedTree: string;
  readonly bundleDigest: string;
  readonly bundleSize: number;
};

export type NativeProjectDraft = LegacyImportedDraft | (ModernDraftBase & (
  | { readonly phase: "import-pending" }
  | { readonly phase: "root-imported"; readonly importReceipt: NativeGitRootImportResult }
));

export class NativeProjectDraftError extends UserError {
  readonly name = "NativeProjectDraftError";
}

export function parseNativeProjectDraft(input: unknown): NativeProjectDraft {
  if (!isRecord(input)) invalid();
  if (input.schemaVersion === 1) return parseLegacyImportedDraft(input);
  if (input.schemaVersion !== 2) invalid();
  const phase = input.phase;
  if (phase !== "import-pending" && phase !== "root-imported") invalid();
  const record = exactRecord(input, phase === "root-imported" ? [...modernFields, "importReceipt"] : modernFields);
  const identity = parseIdentity(record);
  const policy = parseModernPolicy(record, identity);
  const base: ModernDraftBase = { schemaVersion: 2, ...identity, reviewPolicy: policy };
  if (phase === "import-pending") return { ...base, phase };
  return { ...base, phase, importReceipt: parseReceipt(record.importReceipt, base, policy) };
}

function parseLegacyImportedDraft(input: Readonly<Record<string, unknown>>): LegacyImportedDraft {
  const record = exactRecord(input, legacyFields);
  if (record.phase !== "root-imported") invalid();
  const identity = parseIdentity(record);
  const jobs = parseLegacyJobs(record.requiredJobs);
  const review = exactRecord(record.reviewPolicy, ["protectedRef", "policyRevision", "requiredReviewRevision",
    "requiredJobSetRevision", "requiredJobNames", "requiredReviewerIds", "pathReviewerRules"]);
  const compiled = compilePolicy(identity, review.requiredReviewerIds, review.pathReviewerRules, jobs);
  const reviewers = { requiredReviewerIds: compiled.requiredReviewerIds,
    pathReviewerRules: compiled.pathReviewerRules };
  const policy: LegacyReviewPolicy = {
    protectedRef: identity.protectedRef,
    policyRevision: revision("policy", { protectedRef: identity.protectedRef, ...reviewers, requiredJobs: jobs }),
    requiredReviewRevision: revision("reviewers", reviewers),
    requiredJobSetRevision: revision("jobs", jobs),
    requiredJobNames: jobs.map(({ name }) => name), ...reviewers
  };
  if (JSON.stringify(record.reviewPolicy) !== JSON.stringify(policy)) invalid();
  const base = { schemaVersion: 1 as const, ...identity, requiredJobs: jobs, reviewPolicy: policy };
  return { ...base, phase: "root-imported", importReceipt: parseReceipt(record.importReceipt, base, policy) };
}

function parseModernPolicy(
  record: Readonly<Record<string, unknown>>,
  identity: DraftIdentity
): NativeRootBootstrapPolicy["reviewPolicy"] {
  const review = exactRecord(record.reviewPolicy, ["schemaVersion", "protectedRef", "policyRevision",
    "requiredReviewRevision", "requiredJobSetRevision", "requiredJobs", "requiredReviewerIds", "pathReviewerRules"]);
  if (!Array.isArray(review.requiredJobs)) invalid();
  const jobs = review.requiredJobs.map((value) => {
    const job = exactRecord(value, ["name", "kind", "evidenceClass"]);
    if (job.evidenceClass !== "candidate-controlled") invalid();
    return { name: job.name, kind: job.kind };
  });
  const compiled = compilePolicy(identity, review.requiredReviewerIds, review.pathReviewerRules, jobs);
  if (JSON.stringify(record.reviewPolicy) !== JSON.stringify(compiled)) invalid();
  return compiled;
}

function compilePolicy(identity: DraftIdentity, requiredReviewerIds: unknown,
  pathReviewerRules: unknown, requiredJobs: unknown): NativeRootBootstrapPolicy["reviewPolicy"] {
  try {
    return compileNativeRootBootstrapPolicy({ rootAlias: identity.rootAlias, protectedRef: identity.protectedRef,
      review: { requiredReviewerIds, pathReviewerRules, requiredJobs } }).reviewPolicy;
  } catch (error) {
    if (error instanceof UserError) invalid();
    throw error;
  }
}

function parseIdentity(record: Readonly<Record<string, unknown>>): DraftIdentity {
  if (record.recordType !== "native-project-draft" || record.serviceId !== "native-main"
    || record.rootRepositoryId !== "root" || typeof record.name !== "string") invalid();
  let name: string;
  try {
    name = validateLifecycleName(record.name, "project");
  } catch (error) {
    if (error instanceof UserError) invalid();
    throw error;
  }
  const expectedCommit = field(record.expectedCommit, objectIdPattern);
  const expectedTree = field(record.expectedTree, objectIdPattern);
  const bundleSize = record.bundleSize;
  if (expectedTree.length !== expectedCommit.length || typeof bundleSize !== "number"
    || !Number.isSafeInteger(bundleSize) || bundleSize < 1 || bundleSize > 256 * 1024 * 1024 - 64 * 1024 - 1) invalid();
  return { recordType: "native-project-draft", name,
    projectId: field(record.projectId, /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/), serviceId: "native-main",
    ownerHostId: field(record.ownerHostId, /^[a-z0-9][a-z0-9._-]{0,127}$/),
    generationId: field(record.generationId, digestPattern), rootRepositoryId: "root",
    rootAlias: field(record.rootAlias, /^[a-z][a-z0-9-]{0,62}$/),
    protectedRef: field(record.protectedRef, /^refs\/heads\//), expectedCommit, expectedTree,
    bundleDigest: field(record.bundleDigest, digestPattern), bundleSize };
}

function parseLegacyJobs(value: unknown): readonly LegacyRequiredJob[] {
  if (!Array.isArray(value)) invalid();
  return value.map((entry) => {
    const job = exactRecord(entry, ["name", "kind"]);
    if (typeof job.name !== "string" || (job.kind !== "ordinary-sysbox" && job.kind !== "qemu")) invalid();
    return { name: job.name, kind: job.kind };
  });
}

function parseReceipt(value: unknown, base: DraftIdentity, policy: unknown): NativeGitRootImportResult {
  const receipt = exactRecord(value, receiptFields);
  const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  if (receipt.schemaVersion !== 1 || receipt.serviceId !== base.serviceId || receipt.projectId !== base.projectId
    || receipt.rootRepositoryId !== base.rootRepositoryId || receipt.generationId !== base.generationId
    || receipt.protectedRef !== base.protectedRef || receipt.expectedCommit !== base.expectedCommit
    || receipt.policyDigest !== policyDigest || receipt.bundleDigest !== base.bundleDigest
    || receipt.bundleSize !== base.bundleSize || receipt.resolvedTree !== base.expectedTree
    || receipt.phase !== "root-imported") invalid();
  return { schemaVersion: 1, serviceId: "native-main", projectId: base.projectId, rootRepositoryId: "root",
    generationId: base.generationId, importNonce: field(receipt.importNonce,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    protectedRef: base.protectedRef, expectedCommit: base.expectedCommit, policyDigest,
    bundleDigest: base.bundleDigest, bundleSize: base.bundleSize, resolvedTree: base.expectedTree,
    phase: "root-imported" };
}

function revision(domain: "policy" | "reviewers" | "jobs", input: unknown): string {
  return createHash("sha256").update(`dim-native-${domain}-v1\0`).update(JSON.stringify(input)).digest("hex");
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length
    || fields.some((fieldName) => !Object.hasOwn(value, fieldName))) invalid();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) invalid();
  return value;
}

function invalid(): never {
  throw new NativeProjectDraftError("native Project draft is invalid or conflicts with its import binding");
}
