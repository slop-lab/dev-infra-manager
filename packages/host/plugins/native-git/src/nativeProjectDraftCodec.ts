import { createHash } from "node:crypto";
import { UserError } from "@slop-lab/dim-host-core";
import type { NativeGitRootImportResult } from "./nativeGitRootImporterClient.js";
import { compileNativeRepositoryBootstrapPolicy, type NativeRepositoryBootstrapPolicy } from "./nativeRootBootstrapPolicy.js";
import { validateLifecycleName } from "@slop-lab/dim-host-core";

const commonFields = ["recordType", "phase", "name", "projectId", "serviceId", "ownerHostId", "generationId",
  "repositoryId", "protectedRef", "expectedCommit", "expectedTree", "reviewPolicy",
  "bundleDigest", "bundleSize"] as const;
const draftFields = ["schemaVersion", ...commonFields] as const;
const receiptFields = ["schemaVersion", "serviceId", "projectId", "repositoryId", "generationId",
  "importNonce", "protectedRef", "expectedCommit", "policyDigest", "bundleDigest", "bundleSize",
  "resolvedTree", "phase"] as const;
const digestPattern = /^[0-9a-f]{64}$/;
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type DraftBase = DraftIdentity & {
  readonly schemaVersion: 3;
  readonly reviewPolicy: NativeRepositoryBootstrapPolicy["reviewPolicy"];
};
type DraftIdentity = {
  readonly recordType: "native-project-draft";
  readonly name: string;
  readonly projectId: string;
  readonly serviceId: "native-main";
  readonly ownerHostId: string;
  readonly generationId: string;
  readonly repositoryId: string;
    readonly protectedRef: string;
  readonly expectedCommit: string;
  readonly expectedTree: string;
  readonly bundleDigest: string;
  readonly bundleSize: number;
};

export type NativeProjectDraft = DraftBase & (
  | { readonly phase: "import-pending" }
  | { readonly phase: "repository-imported"; readonly importReceipt: NativeGitRootImportResult }
);

export class NativeProjectDraftError extends UserError {
  readonly name = "NativeProjectDraftError";
}

export function parseNativeProjectDraft(input: unknown): NativeProjectDraft {
  if (!isRecord(input)) invalid();
  if (input.schemaVersion !== 3) invalid();
  const phase = input.phase;
  if (phase !== "import-pending" && phase !== "repository-imported") invalid();
  const record = exactRecord(input, phase === "repository-imported" ? [...draftFields, "importReceipt"] : draftFields);
  const identity = parseIdentity(record);
  const policy = parsePolicy(record, identity);
  const base: DraftBase = { schemaVersion: 3, ...identity, reviewPolicy: policy };
  if (phase === "import-pending") return { ...base, phase };
  return { ...base, phase, importReceipt: parseReceipt(record.importReceipt, base, policy) };
}

function parsePolicy(
  record: Readonly<Record<string, unknown>>,
  identity: DraftIdentity
): NativeRepositoryBootstrapPolicy["reviewPolicy"] {
  const review = exactRecord(record.reviewPolicy, ["schemaVersion", "protectedRef", "policyRevision",
    "requiredReviewRevision", "requiredJobSetRevision", "requiredJobs", "requiredReviewerIds", "pathReviewerRules", "ciRepositoryIds"]);
  if (!Array.isArray(review.requiredJobs)) invalid();
  const jobs = review.requiredJobs.map((value) => {
    const job = exactRecord(value, ["name", "kind", "evidenceClass"]);
    if (job.evidenceClass !== "candidate-controlled") invalid();
    return { name: job.name, kind: job.kind };
  });
  const compiled = compilePolicy(identity, review.requiredReviewerIds, review.pathReviewerRules, jobs, review.ciRepositoryIds);
  if (JSON.stringify(record.reviewPolicy) !== JSON.stringify(compiled)) invalid();
  return compiled;
}

function compilePolicy(identity: DraftIdentity, requiredReviewerIds: unknown,
  pathReviewerRules: unknown, requiredJobs: unknown, ciRepositoryIds: unknown): NativeRepositoryBootstrapPolicy["reviewPolicy"] {
  try {
    return compileNativeRepositoryBootstrapPolicy({ repositoryId: identity.repositoryId, protectedRef: identity.protectedRef,
      review: { requiredReviewerIds, pathReviewerRules, requiredJobs, ciRepositoryIds } }).reviewPolicy;
  } catch (error) {
    if (error instanceof UserError) invalid();
    throw error;
  }
}

function parseIdentity(record: Readonly<Record<string, unknown>>): DraftIdentity {
  if (record.recordType !== "native-project-draft" || record.serviceId !== "native-main"
    || typeof record.name !== "string") invalid();
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
    generationId: field(record.generationId, digestPattern), repositoryId: field(record.repositoryId, /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
    protectedRef: field(record.protectedRef, /^refs\/heads\//), expectedCommit, expectedTree,
    bundleDigest: field(record.bundleDigest, digestPattern), bundleSize };
}

function parseReceipt(value: unknown, base: DraftIdentity, policy: unknown): NativeGitRootImportResult {
  const receipt = exactRecord(value, receiptFields);
  const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  if (receipt.schemaVersion !== 1 || receipt.serviceId !== base.serviceId || receipt.projectId !== base.projectId
    || receipt.repositoryId !== base.repositoryId || receipt.generationId !== base.generationId
    || receipt.protectedRef !== base.protectedRef || receipt.expectedCommit !== base.expectedCommit
    || receipt.policyDigest !== policyDigest || receipt.bundleDigest !== base.bundleDigest
    || receipt.bundleSize !== base.bundleSize || receipt.resolvedTree !== base.expectedTree
    || receipt.phase !== "repository-imported") invalid();
  return { schemaVersion: 1, serviceId: "native-main", projectId: base.projectId, repositoryId: base.repositoryId,
    generationId: base.generationId, importNonce: field(receipt.importNonce,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    protectedRef: base.protectedRef, expectedCommit: base.expectedCommit, policyDigest,
    bundleDigest: base.bundleDigest, bundleSize: base.bundleSize, resolvedTree: base.expectedTree,
    phase: "repository-imported" };
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
