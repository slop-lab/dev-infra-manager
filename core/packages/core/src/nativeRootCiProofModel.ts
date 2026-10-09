import { createHash } from "node:crypto";
import {
  parseNativeRootCiReviewEvent,
  type NativeRootCiReviewEvent
} from "./nativeRootCiReviewEvent.js";

const digestPattern = /^[0-9a-f]{64}$/;
const objectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const identifierPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const jobPattern = /^[a-z][a-z0-9-]{0,62}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type NativeRootCiRequiredJob = {
  readonly name: string;
  readonly kind: "ordinary-sysbox" | "qemu";
  readonly evidenceClass: "candidate-controlled";
};
export type NativeRootCiPathReviewerRule = {
  readonly pathPrefix: string;
  readonly reviewerIds: readonly string[];
};
export type NativeRootCiPolicy = {
  readonly schemaVersion: 1;
  readonly protectedRef: string;
  readonly policyRevision: string;
  readonly requiredReviewRevision: string;
  readonly requiredJobSetRevision: string;
  readonly requiredJobs: readonly NativeRootCiRequiredJob[];
  readonly requiredReviewerIds: readonly string[];
  readonly pathReviewerRules: readonly NativeRootCiPathReviewerRule[];
};
export type NativeRootCiCurrentRoot = {
  readonly importNonce: string;
  readonly sequence: number;
  readonly protectedRef: string;
  readonly commit: string;
  readonly tree: string;
  readonly policyDigest: string;
};
export type NativeRootCiPolicyProof = {
  readonly schemaVersion: 1;
  readonly serviceId: "native-main";
  readonly requestId: string;
  readonly servingGenerationId: string;
  readonly projectId: string;
  readonly repositoryId: "root";
  readonly currentRoot: NativeRootCiCurrentRoot;
  readonly policy: NativeRootCiPolicy;
};
export type { NativeRootCiReviewEvent } from "./nativeRootCiReviewEvent.js";
export type NativeRootCiReviewEventProof = NativeRootCiPolicyProof & {
  readonly reviewLiveness: "current";
  readonly event: NativeRootCiReviewEvent;
};
export type NativeRootCiProofExpectation = {
  readonly serviceId: "native-main";
  readonly generationId: string;
  readonly requestId: string;
  readonly projectId: string;
};
export type NativeRootCiReviewSelector = {
  readonly projectId: string;
  readonly importNonce: string;
  readonly policyDigest: string;
  readonly eventId: string;
  readonly reviewId: string;
  readonly executionKind: "ordinary-sysbox";
  readonly jobName: string;
};

export function parseNativeRootCiPolicyProof(
  value: unknown,
  expected: NativeRootCiProofExpectation
): NativeRootCiPolicyProof {
  const outer = exactRecord(value, ["schemaVersion", "serviceId", "requestId", "servingGenerationId",
    "projectId", "repositoryId", "currentRoot", "policy"]);
  if (outer.schemaVersion !== 1 || outer.serviceId !== expected.serviceId || outer.requestId !== expected.requestId
    || outer.servingGenerationId !== expected.generationId || outer.projectId !== expected.projectId
    || outer.repositoryId !== "root") invalid();
  const policy = parsePolicy(outer.policy);
  const currentRoot = parseCurrentRoot(outer.currentRoot, policy);
  return { schemaVersion: 1, serviceId: "native-main", requestId: expected.requestId,
    servingGenerationId: expected.generationId, projectId: expected.projectId,
    repositoryId: "root", currentRoot, policy };
}

export function parseNativeRootCiReviewEventProof(value: unknown, expected: NativeRootCiProofExpectation,
  selector: NativeRootCiReviewSelector): NativeRootCiReviewEventProof {
  const outer = exactRecord(value, ["schemaVersion", "serviceId", "requestId", "servingGenerationId",
    "projectId", "repositoryId", "currentRoot", "policy", "reviewLiveness", "event"]);
  const policyProof = parseNativeRootCiPolicyProof(Object.fromEntries(Object.entries(outer)
    .filter(([key]) => key !== "reviewLiveness" && key !== "event")), expected);
  if (outer.reviewLiveness !== "current" || policyProof.currentRoot.importNonce !== selector.importNonce
    || policyProof.currentRoot.policyDigest !== selector.policyDigest) invalid();
  if (!policyProof.policy.requiredJobs.some((job) => job.name === selector.jobName
    && job.kind === "ordinary-sysbox" && job.evidenceClass === "candidate-controlled")) invalid();
  const event = parseEvent(outer.event, policyProof, selector);
  return { ...policyProof, reviewLiveness: "current", event };
}

function parsePolicy(value: unknown): NativeRootCiPolicy {
  const policy = exactRecord(value, ["schemaVersion", "protectedRef", "policyRevision", "requiredReviewRevision",
    "requiredJobSetRevision", "requiredJobs", "requiredReviewerIds", "pathReviewerRules"]);
  if (policy.schemaVersion !== 1 || typeof policy.protectedRef !== "string" || !safeProtectedRef(policy.protectedRef)
    || !isDigest(policy.policyRevision) || !isDigest(policy.requiredReviewRevision)
    || !isDigest(policy.requiredJobSetRevision)) invalid();
  const requiredJobs = array(policy.requiredJobs).map(parseJob);
  const requiredReviewerIds = array(policy.requiredReviewerIds).map(parseIdentifier);
  const pathReviewerRules = array(policy.pathReviewerRules).map(parseRule);
  assertSortedUnique(requiredJobs.map(({ name }) => name));
  assertSortedUnique(requiredReviewerIds);
  assertSortedUnique(pathReviewerRules.map((rule) => JSON.stringify(rule)), true);
  const reviewers = { requiredReviewerIds, pathReviewerRules };
  if (policy.requiredReviewRevision !== revision("reviewers", 1, reviewers)
    || policy.requiredJobSetRevision !== revision("jobs", 2, requiredJobs)
    || policy.policyRevision !== revision("policy", 2,
      { protectedRef: policy.protectedRef, ...reviewers, requiredJobs })) invalid();
  return { schemaVersion: 1, protectedRef: policy.protectedRef, policyRevision: policy.policyRevision,
    requiredReviewRevision: policy.requiredReviewRevision, requiredJobSetRevision: policy.requiredJobSetRevision,
    requiredJobs, requiredReviewerIds, pathReviewerRules };
}

function parseCurrentRoot(value: unknown, policy: NativeRootCiPolicy): NativeRootCiCurrentRoot {
  const root = exactRecord(value, ["importNonce", "sequence", "protectedRef", "commit", "tree", "policyDigest"]);
  if (typeof root.importNonce !== "string" || !uuidPattern.test(root.importNonce)
    || typeof root.sequence !== "number" || !Number.isSafeInteger(root.sequence) || root.sequence < 0
    || root.protectedRef !== policy.protectedRef || !isObjectId(root.commit) || !isObjectId(root.tree)
    || root.commit.length !== root.tree.length || !isDigest(root.policyDigest)
    || root.policyDigest !== createHash("sha256").update(JSON.stringify(policy)).digest("hex")) invalid();
  return { importNonce: root.importNonce, sequence: root.sequence, protectedRef: policy.protectedRef,
    commit: root.commit, tree: root.tree, policyDigest: root.policyDigest };
}

function parseEvent(value: unknown, proof: NativeRootCiPolicyProof,
  selector: NativeRootCiReviewSelector): NativeRootCiReviewEvent {
  let event: NativeRootCiReviewEvent;
  try { event = parseNativeRootCiReviewEvent(value); }
  catch (error) {
    if (error instanceof Error && error.name === "NativeRootCiReviewEventError") invalid();
    throw error;
  }
  if (event.eventId !== selector.eventId || event.projectId !== selector.projectId
    || event.protectedRef !== proof.currentRoot.protectedRef || event.reviewId !== selector.reviewId
    || event.expectedProtectedHead !== proof.currentRoot.commit || !isObjectId(event.candidateCommit)
    || !isObjectId(event.candidateTree) || event.candidateCommit.length !== proof.currentRoot.commit.length
    || event.candidateTree.length !== proof.currentRoot.commit.length
    || event.policyRevision !== proof.policy.policyRevision
    || event.requiredReviewRevision !== proof.policy.requiredReviewRevision
    || event.requiredJobSetRevision !== proof.policy.requiredJobSetRevision
    || event.jobName !== selector.jobName) invalid();
  return event;
}

function parseJob(value: unknown): NativeRootCiRequiredJob {
  const job = exactRecord(value, ["name", "kind", "evidenceClass"]);
  if (typeof job.name !== "string" || !jobPattern.test(job.name)
    || (job.kind !== "ordinary-sysbox" && job.kind !== "qemu")
    || job.evidenceClass !== "candidate-controlled") invalid();
  return { name: job.name, kind: job.kind, evidenceClass: "candidate-controlled" };
}

function parseRule(value: unknown): NativeRootCiPathReviewerRule {
  const rule = exactRecord(value, ["pathPrefix", "reviewerIds"]);
  if (typeof rule.pathPrefix !== "string" || rule.pathPrefix.length < 1 || rule.pathPrefix.length > 1024
    || rule.pathPrefix.startsWith("/") || rule.pathPrefix.includes("\0") || rule.pathPrefix.includes("//")
    || rule.pathPrefix.split("/").some((part) => part === "." || part === "..")) invalid();
  const reviewerIds = array(rule.reviewerIds).map(parseIdentifier);
  assertSortedUnique(reviewerIds);
  return { pathPrefix: rule.pathPrefix, reviewerIds };
}

function parseIdentifier(value: unknown): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) invalid();
  return value;
}

function exactRecord(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) invalid();
  return Object.fromEntries(fields.map((field) => [field, Reflect.get(value, field)]));
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

function assertSortedUnique(values: readonly string[], allowEmpty = false): void {
  if ((!allowEmpty && values.length < 1) || new Set(values).size !== values.length
    || values.some((value, index) => index > 0 && value <= (values[index - 1] ?? ""))) invalid();
}

function safeProtectedRef(value: string): boolean {
  return value.startsWith("refs/heads/") && !value.startsWith("refs/heads/proposals/") && !value.endsWith("/")
    && !value.endsWith(".") && !value.endsWith(".lock") && !value.includes("..") && !value.includes("@{")
    && !value.includes("\\") && !/[\x00-\x20\x7f~^:?*[\]]/.test(value)
    && value.slice("refs/heads/".length).split("/").every((part) => part.length > 0 && !part.startsWith("."));
}

function revision(domain: "policy" | "reviewers" | "jobs", version: 1 | 2, value: unknown): string {
  return createHash("sha256").update(`dim-native-${domain}-v${version}\0`).update(JSON.stringify(value)).digest("hex");
}

function isDigest(value: unknown): value is string { return typeof value === "string" && digestPattern.test(value); }
function isObjectId(value: unknown): value is string { return typeof value === "string" && objectPattern.test(value); }
function invalid(): never { throw new NativeRootCiProofShapeError(); }

export class NativeRootCiProofShapeError extends Error {
  readonly name = "NativeRootCiProofShapeError";
}
