import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { UserError } from "./errors.js";
import { validateLifecycleName } from "./lifecycleRecord.js";
import { normalizeRepositoryRef } from "./repositoryRef.js";
import { assertRepositorySetUrlsArePortable, normalizeRepositorySet } from "./repositorySetValidation.js";

const maximumManifestBytes = 64 * 1024;
const reviewerPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const jobPattern = /^[a-z][a-z0-9-]{0,62}$/;

type RequiredJob = { readonly name: string; readonly kind: "ordinary-sysbox" | "qemu" };
type ImportedRequiredJob = RequiredJob & { readonly evidenceClass: "candidate-controlled" };
type PathReviewerRule = { readonly pathPrefix: string; readonly reviewerIds: readonly string[] };

export type NativeRootBootstrapPolicy = {
  readonly rootAlias: string;
  readonly protectedRef: string;
  readonly reviewPolicy: {
    readonly schemaVersion: 1;
    readonly protectedRef: string;
    readonly policyRevision: string;
    readonly requiredReviewRevision: string;
    readonly requiredJobSetRevision: string;
    readonly requiredJobs: readonly ImportedRequiredJob[];
    readonly requiredReviewerIds: readonly string[];
    readonly pathReviewerRules: readonly PathReviewerRule[];
  };
};

export function compileNativeRootBootstrapPolicy(input: {
  readonly rootAlias: string;
  readonly protectedRef: string;
  readonly review: unknown;
}): NativeRootBootstrapPolicy {
  const rootAlias = validateLifecycleName(input.rootAlias, "native root alias");
  const protectedRef = normalizeRepositoryRef(input.protectedRef);
  if (protectedRef !== input.protectedRef || !safeHeadRef(protectedRef)) {
    throw new UserError("native root protected ref must be a safe concrete branch outside proposals");
  }
  const review = exactRecord(input.review, ["requiredReviewerIds", "requiredJobs"], ["pathReviewerRules"],
    "native root review policy");
  const requiredReviewerIds = reviewerIds(review.requiredReviewerIds, "required reviewers").sort();
  const requiredJobs = entries(review.requiredJobs, "required jobs").map((value): RequiredJob => {
    const job = exactRecord(value, ["name", "kind"], [], "required job");
    if (typeof job.name !== "string" || !jobPattern.test(job.name)
      || (job.kind !== "ordinary-sysbox" && job.kind !== "qemu")) {
      throw new UserError("native required job name or execution kind is invalid");
    }
    return { name: job.name, kind: job.kind };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (requiredJobs.length < 1 || requiredJobs.length > 64
    || new Set(requiredJobs.map(({ name }) => name)).size !== requiredJobs.length) {
    throw new UserError("native required jobs must be distinct and nonempty");
  }
  const pathReviewerRules = (review.pathReviewerRules === undefined
    ? [] : entries(review.pathReviewerRules, "path reviewer rules", true)).map((value) => {
    const rule = exactRecord(value, ["pathPrefix", "reviewerIds"], [], "path reviewer rule");
    if (typeof rule.pathPrefix !== "string" || rule.pathPrefix.length < 1 || rule.pathPrefix.length > 1024
      || rule.pathPrefix.startsWith("/") || rule.pathPrefix.includes("\0") || rule.pathPrefix.includes("//")
      || rule.pathPrefix.split("/").some((component) => component === "." || component === "..")) {
      throw new UserError("native path reviewer prefix is unsafe");
    }
    return { pathPrefix: rule.pathPrefix, reviewerIds: reviewerIds(rule.reviewerIds, "path reviewers").sort() };
  }).sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const reviews = { requiredReviewerIds, pathReviewerRules };
  const importedJobs = requiredJobs.map((job): ImportedRequiredJob => ({
    ...job, evidenceClass: "candidate-controlled"
  }));
  const policyRevision = revision("policy", 2, { protectedRef, ...reviews, requiredJobs: importedJobs });
  return {
    rootAlias, protectedRef,
    reviewPolicy: { schemaVersion: 1, protectedRef, policyRevision,
      requiredReviewRevision: revision("reviewers", 1, reviews),
      requiredJobSetRevision: revision("jobs", 2, importedJobs),
      requiredJobs: importedJobs, ...reviews }
  };
}

export function parseNativeRootBootstrapManifestYaml(
  source: string,
  selectedRef: string
): NativeRootBootstrapPolicy {
  if (Buffer.byteLength(source, "utf8") > maximumManifestBytes) {
    throw new UserError("native bootstrap manifest exceeds 64 KiB");
  }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new UserError(`native bootstrap manifest is invalid YAML: ${document.errors[0]?.message ?? "unknown error"}`);
  }
  const manifest = exactRecord(document.toJS({ maxAliasCount: 0 }),
    ["schemaVersion", "repositories", "nativeReview"], ["upstreams"], "native bootstrap manifest");
  const set = normalizeRepositorySet({
    schemaVersion: manifest.schemaVersion, repositories: manifest.repositories, upstreams: manifest.upstreams
  }, "native bootstrap manifest");
  assertRepositorySetUrlsArePortable(set, "native bootstrap manifest");
  const roots = Object.entries(set.repositories).filter(([, entry]) => entry.root);
  if (roots.length !== 1) throw new UserError("native bootstrap manifest must have exactly one root");
  const root = roots[0];
  if (root === undefined) throw new UserError("native bootstrap root is missing");
  const [rootAlias, entry] = root;
  const normalizedRef = normalizeRepositoryRef(selectedRef);
  if (entry.ref !== undefined && entry.ref !== normalizedRef) {
    throw new UserError("native bootstrap selected ref conflicts with the reviewed root ref");
  }
  const branch = normalizedRef.slice("refs/heads/".length);
  if (!entry.protectedPatterns.some((pattern) => matchesProtectionPattern(branch, pattern))) {
    throw new UserError("native bootstrap root branch is not protected by the reviewed manifest");
  }
  return compileNativeRootBootstrapPolicy({ rootAlias, protectedRef: normalizedRef, review: manifest.nativeReview });
}

function safeHeadRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") && !ref.startsWith("refs/heads/proposals/")
    && !ref.endsWith("/") && !ref.endsWith(".") && !ref.endsWith(".lock")
    && !ref.includes("..") && !ref.includes("@{") && !ref.includes("\\")
    && !/[\x00-\x20\x7f~^:?*[\]]/.test(ref)
    && ref.slice("refs/heads/".length).split("/")
      .every((component) => component.length > 0 && !component.startsWith("."));
}

function matchesProtectionPattern(branch: string, pattern: string): boolean {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${expression}$`).test(branch);
}

function reviewerIds(value: unknown, label: string): string[] {
  const ids = entries(value, label);
  if (ids.some((id) => typeof id !== "string" || !reviewerPattern.test(id))
    || new Set(ids).size !== ids.length) throw new UserError(`native ${label} are invalid or duplicated`);
  return ids.map((id) => String(id));
}

function entries(value: unknown, label: string, allowEmpty = false): readonly unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1)) {
    throw new UserError(`native ${label} must be ${allowEmpty ? "an array" : "a nonempty array"}`);
  }
  return value;
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string)
  : Readonly<Record<string, unknown>> {
  if (!isRecord(value) || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new UserError(`${label} contains missing or unknown fields`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revision(domain: string, version: 1 | 2, input: unknown): string {
  return createHash("sha256").update(`dim-native-${domain}-v${version}\0`).update(JSON.stringify(input)).digest("hex");
}
