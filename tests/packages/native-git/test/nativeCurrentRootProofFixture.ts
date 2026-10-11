import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  nativeProjectRootPromotionEvidenceDigest,
  nativeProjectRootPromotionTransitionId,
  type NativeProjectRootPromotionEvidence,
  type NativeProjectRootPromotionTransition
} from "../../../../core/packages/native-git/src/native-project-root-promotion-codec.js";
import { parseAuthoritativeImportedRootPolicy } from "../../../../core/packages/native-git/src/native-imported-root-policy.js";
import { generationId, rootRepository, runGit } from "./nativeRootImportFinalizeFixture.js";
import { reviewProposalRef } from "./nativeBundleReviewFixture.js";

type SeedPromotionInput = {
  readonly root: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly recordedCandidateTree?: string;
  readonly phase?: "finalized" | "intent";
};

export async function seedRootPromotion(input: SeedPromotionInput): Promise<void> {
  const databasePath = join(input.root, "native-idle.sqlite3");
  const database = new DatabaseSync(databasePath);
  try {
    const imported = requiredRecord(database.prepare(`SELECT import_nonce, expected_commit, resolved_tree,
      policy_json, policy_sha256 FROM native_project_root_import WHERE project_id = 'project-a'`).get());
    const policy = parseAuthoritativeImportedRootPolicy(JSON.parse(stringField(imported, "policy_json")));
    const requiredReviewerIds = [...policy.requiredReviewerIds];
    const evidence: NativeProjectRootPromotionEvidence = {
      schemaVersion: 1,
      reviewId: "4".repeat(64),
      requiredReviewerIds,
      approvals: requiredReviewerIds.map((reviewerId) => ({ reviewerId,
        approvalDigest: evidenceIdentity("approval", reviewerId) })),
      jobs: policy.requiredJobs.map(({ name, kind, evidenceClass }) => ({
        executionKind: kind,
        jobName: name,
        evidenceClass,
        evidenceDigest: evidenceIdentity(kind, name)
      })).sort((left, right) => left.executionKind.localeCompare(right.executionKind)
        || left.jobName.localeCompare(right.jobName))
    };
    const evidenceJson = JSON.stringify(evidence);
    const evidenceDigest = nativeProjectRootPromotionEvidenceDigest(evidence);
    const identity: Omit<NativeProjectRootPromotionTransition, "transitionId" | "evidence"> = {
      projectId: "project-a",
      importNonce: stringField(imported, "import_nonce"),
      sequence: 1,
      reviewId: evidence.reviewId,
      protectedRef: "refs/heads/main",
      proposalRef: reviewProposalRef,
      expectedCommit: stringField(imported, "expected_commit"),
      expectedTree: stringField(imported, "resolved_tree"),
      candidateCommit: input.candidateCommit,
      candidateTree: input.recordedCandidateTree ?? input.candidateTree,
      decisionGeneration: generationId,
      policyDigest: stringField(imported, "policy_sha256"),
      policyRevision: policy.policyRevision,
      requiredReviewRevision: policy.requiredReviewRevision,
      requiredJobSetRevision: policy.requiredJobSetRevision,
      evidenceDigest
    };
    const table = input.phase === "intent"
      ? "native_project_root_promotion_intent"
      : "native_project_root_promotion_finalized";
    database.prepare(`INSERT INTO ${table}
      (project_id, transition_id, import_nonce, sequence, review_id, protected_ref, proposal_ref,
       expected_commit, expected_tree, candidate_commit, candidate_tree, decision_generation,
       policy_sha256, policy_revision, required_review_revision, required_job_set_revision,
       evidence_json, evidence_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(identity.projectId, nativeProjectRootPromotionTransitionId(identity), identity.importNonce,
        identity.sequence, identity.reviewId, identity.protectedRef, identity.proposalRef,
        identity.expectedCommit, identity.expectedTree, identity.candidateCommit, identity.candidateTree,
        identity.decisionGeneration, identity.policyDigest, identity.policyRevision,
        identity.requiredReviewRevision, identity.requiredJobSetRevision, evidenceJson, evidenceDigest);
  } finally {
    database.close();
  }
  if (input.phase !== "intent") {
    await runGit("/usr/bin/git", ["--git-dir", rootRepository(input.root), "update-ref",
      "refs/heads/main", input.candidateCommit]);
  }
}

export async function detachedCommit(root: string, tree: string): Promise<string> {
  return (await runGit("/usr/bin/git", ["--git-dir", rootRepository(root),
    "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
    "commit-tree", tree, "-m", "detached current root"])).stdout.trim();
}

export async function descendantCommit(root: string, tree: string, parent: string): Promise<string> {
  return (await runGit("/usr/bin/git", ["--git-dir", rootRepository(root),
    "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
    "commit-tree", tree, "-p", parent, "-m", "descendant current root"])).stdout.trim();
}

function requiredRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new ProofFixtureError();
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Readonly<Record<string, unknown>>, name: string): string {
  const field = value[name];
  if (typeof field !== "string") throw new ProofFixtureError();
  return field;
}

class ProofFixtureError extends Error {
  readonly name = "ProofFixtureError";
}

function evidenceIdentity(kind: string, value: string): string {
  return createHash("sha256").update(`${kind}\0${value}`).digest("hex");
}
