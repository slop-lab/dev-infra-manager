import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const jobName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const proposalRef = z.string().min(1).max(1024).refine((value) =>
  /^refs\/heads\/proposals\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9._/-]+$/.test(value)
  && !value.includes("//") && !value.includes("..") && !value.includes("/.")
  && !value.endsWith("/") && !value.endsWith(".") && !value.endsWith(".lock"));
const approvalEvidence = z.object({
  reviewerId: identifier,
  approvalDigest: digest
}).strict().readonly();
const jobEvidence = z.object({
  executionKind: z.enum(["ordinary-sysbox", "qemu"]),
  jobName,
  evidenceClass: z.literal("candidate-controlled"),
  evidenceDigest: digest
}).strict().readonly();
const promotionEvidence = z.object({
  schemaVersion: z.literal(1),
  reviewId: digest,
  requiredReviewerIds: z.array(identifier).min(1).readonly(),
  approvals: z.array(approvalEvidence).min(1).readonly(),
  jobs: z.array(jobEvidence).min(1).max(64).readonly()
}).strict().readonly();
const storedTransition = z.object({
  projectId: identifier,
  transitionId: digest,
  importNonce: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reviewId: digest,
  protectedRef: z.string().min(1).max(1024),
  proposalRef,
  expectedCommit: objectId,
  expectedTree: objectId,
  candidateCommit: objectId,
  candidateTree: objectId,
  decisionGeneration: digest,
  policyDigest: digest,
  policyRevision: digest,
  requiredReviewRevision: digest,
  requiredJobSetRevision: digest,
  evidenceJson: z.string(),
  evidenceDigest: digest
}).strict().readonly();

export type NativeProjectRootPromotionEvidence = z.infer<typeof promotionEvidence>;
export type NativeProjectRootPromotionTransition = Omit<z.infer<typeof storedTransition>, "evidenceJson"> & {
  readonly evidence: NativeProjectRootPromotionEvidence;
};

export function nativeProjectRootPromotionEvidenceDigest(evidence: NativeProjectRootPromotionEvidence): string {
  return domainDigest("dim-native-root-promotion-evidence-v1\0", evidence);
}

export function nativeProjectRootPromotionTransitionId(
  transition: Omit<NativeProjectRootPromotionTransition, "transitionId" | "evidence">
): string {
  return domainDigest("dim-native-root-promotion-transition-v1\0", transition);
}

export function parseNativeProjectRootPromotionRow(row: unknown): NativeProjectRootPromotionTransition {
  if (!isRecord(row)) throw new NativeProjectRootPromotionStateError("native Project root promotion row is invalid");
  const result = storedTransition.safeParse({
    projectId: row.project_id, transitionId: row.transition_id, importNonce: row.import_nonce,
    sequence: row.sequence, reviewId: row.review_id, protectedRef: row.protected_ref,
    proposalRef: row.proposal_ref, expectedCommit: row.expected_commit, expectedTree: row.expected_tree,
    candidateCommit: row.candidate_commit, candidateTree: row.candidate_tree,
    decisionGeneration: row.decision_generation, policyDigest: row.policy_sha256,
    policyRevision: row.policy_revision, requiredReviewRevision: row.required_review_revision,
    requiredJobSetRevision: row.required_job_set_revision, evidenceJson: row.evidence_json,
    evidenceDigest: row.evidence_sha256
  });
  if (!result.success) {
    throw new NativeProjectRootPromotionStateError("native Project root promotion row is invalid", {
      cause: result.error
    });
  }
  const evidence = parseEvidence(result.data.evidenceJson);
  const { evidenceJson: _evidenceJson, ...identity } = result.data;
  if (JSON.stringify(evidence) !== result.data.evidenceJson
    || nativeProjectRootPromotionEvidenceDigest(evidence) !== result.data.evidenceDigest) {
    throw new NativeProjectRootPromotionStateError("native Project root promotion evidence digest is invalid");
  }
  const transition = { ...identity, evidence };
  const { transitionId: _transitionId, evidence: _evidence, ...transitionIdentity } = transition;
  if (evidence.reviewId !== transition.reviewId
    || nativeProjectRootPromotionTransitionId(transitionIdentity) !== transition.transitionId) {
    throw new NativeProjectRootPromotionStateError("native Project root promotion transition identity is invalid");
  }
  if (new Set([transition.expectedCommit.length, transition.expectedTree.length,
    transition.candidateCommit.length, transition.candidateTree.length]).size !== 1) {
    throw new NativeProjectRootPromotionStateError("native Project root promotion object formats conflict");
  }
  return transition;
}

function parseEvidence(value: string): NativeProjectRootPromotionEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new NativeProjectRootPromotionStateError("native Project root promotion evidence is invalid", {
        cause: error
      });
    }
    throw error;
  }
  const result = promotionEvidence.safeParse(parsed);
  if (!result.success) {
    throw new NativeProjectRootPromotionStateError("native Project root promotion evidence is invalid", {
      cause: result.error
    });
  }
  assertSortedUnique(result.data.requiredReviewerIds, "required reviewers");
  assertSortedUnique(result.data.approvals.map(({ reviewerId }) => reviewerId), "approvals");
  assertSortedUnique(result.data.jobs.map(({ executionKind, jobName: name }) => `${executionKind}\0${name}`), "jobs");
  assertUnique(result.data.approvals.map(({ approvalDigest }) => approvalDigest), "approval digests");
  assertUnique(result.data.jobs.map(({ evidenceDigest }) => evidenceDigest), "job evidence digests");
  if (JSON.stringify(result.data.requiredReviewerIds)
    !== JSON.stringify(result.data.approvals.map(({ reviewerId }) => reviewerId))) {
    throw new NativeProjectRootPromotionStateError("native Project root promotion approval evidence is incomplete");
  }
  return result.data;
}

function assertSortedUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length || values.some((value, index) => {
    const previous = values[index - 1];
    return previous !== undefined && value <= previous;
  })) throw new NativeProjectRootPromotionStateError(`native Project root promotion ${label} are not canonical`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new NativeProjectRootPromotionStateError(`native Project root promotion ${label} are not unique`);
  }
}

function domainDigest(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) canonical[key] = canonicalValue(Reflect.get(value, key));
  return canonical;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class NativeProjectRootPromotionStateError extends Error {
  readonly name = "NativeProjectRootPromotionStateError";
}
