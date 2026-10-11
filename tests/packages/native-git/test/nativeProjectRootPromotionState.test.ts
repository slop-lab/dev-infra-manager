import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeGitBundleDatabase } from "../../../../core/packages/native-git/src/native-bundle-state-validation.js";
import {
  nativeProjectRootPromotionEvidenceDigest,
  nativeProjectRootPromotionTransitionId,
  type NativeProjectRootPromotionEvidence,
  type NativeProjectRootPromotionTransition
} from "../../../../core/packages/native-git/src/native-project-root-promotion-codec.js";
import {
  assertNativeProjectRootPromotionRows,
  readNativeProjectRootCurrentHeadFromDatabase
} from "../../../../core/packages/native-git/src/native-project-root-promotion-state.js";

const roots: string[] = [];
const projectId = "project-a";
const importNonce = "11111111-1111-4111-8111-111111111111";
const decisionGeneration = "1".repeat(64);
const protectedRef = "refs/heads/main";
const proposalRef = `refs/heads/proposals/${"A".repeat(43)}/change`;
const initialCommit = "a".repeat(40);
const initialTree = "b".repeat(40);
const candidateCommit = "c".repeat(40);
const candidateTree = "d".repeat(40);
const policy = {
  schemaVersion: 1,
  protectedRef,
  policyRevision: "fdffae92e9014e33a9403f93357910d07597a3b714145ae8919af7fa7213b1ac",
  requiredReviewRevision: "ff16b06bda98a4c379e4b5134f68f6ff5892908e71adc784236d74fe796905a9",
  requiredJobSetRevision: "0ad50d5aeb109a11fa76caa3fcd0614d39d69331d2e27520078dc814bb1426c1",
  requiredJobs: [
    { name: "security", kind: "qemu", evidenceClass: "candidate-controlled" },
    { name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }
  ],
  requiredReviewerIds: ["owner", "security-owner"],
  pathReviewerRules: [{ pathPrefix: ".dim/", reviewerIds: ["lifecycle-owner", "owner"] }]
} as const;
const policyJson = JSON.stringify(policy);
const policyDigest = createHash("sha256").update(policyJson).digest("hex");
const promotionEvidence = {
  schemaVersion: 1,
  reviewId: "4".repeat(64),
  requiredReviewerIds: ["owner", "security-owner"],
  approvals: [
    { reviewerId: "owner", approvalDigest: "5".repeat(64) },
    { reviewerId: "security-owner", approvalDigest: "6".repeat(64) }
  ],
  jobs: [
    { executionKind: "ordinary-sysbox", jobName: "source", evidenceClass: "candidate-controlled",
      evidenceDigest: "7".repeat(64) },
    { executionKind: "qemu", jobName: "security", evidenceClass: "candidate-controlled",
      evidenceDigest: "8".repeat(64) }
  ]
} as const satisfies NativeProjectRootPromotionEvidence;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Project root promotion state", () => {
  it("returns the immutable imported root as sequence zero when no promotion exists", async () => {
    // Given
    const databasePath = await seededDatabase();

    // When
    const current = readNativeProjectRootCurrentHeadFromDatabase(databasePath, projectId);

    // Then
    expect(current).toEqual({
      projectId,
      sequence: 0,
      protectedRef,
      commit: initialCommit,
      tree: initialTree,
      policyDigest
    });
  });

  it("withholds a finalized row that has no independently verified authorization", async () => {
    // Given
    const databasePath = await seededDatabase();
    insertTransition(databasePath, "native_project_root_promotion_finalized", {
      sequence: 1,
      expectedCommit: initialCommit,
      candidateCommit,
      candidateTree,
      transitionPolicyDigest: policyDigest
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(() => assertNativeProjectRootPromotionRows(database)).toThrow(/evidence is not yet verified/);
    database.close();

    // When / Then
    expect(() => readNativeProjectRootCurrentHeadFromDatabase(databasePath, projectId))
      .toThrow(/evidence is not yet verified/);
  });

  it.each([
    ["a noncontiguous sequence", { sequence: 2, expectedCommit: initialCommit, transitionPolicyDigest: policyDigest }],
    ["a foreign parent", { sequence: 1, expectedCommit: "e".repeat(40), transitionPolicyDigest: policyDigest }],
    ["a foreign policy", { sequence: 1, expectedCommit: initialCommit, transitionPolicyDigest: "f".repeat(64) }]
  ])("rejects a finalized chain with %s", async (_label, malformed) => {
    // Given
    const databasePath = await seededDatabase();
    insertTransition(databasePath, "native_project_root_promotion_finalized", {
      ...malformed,
      candidateCommit,
      candidateTree
    });

    // When / Then
    expect(() => readNativeProjectRootCurrentHeadFromDatabase(databasePath, projectId)).toThrow(/chain/i);
  });

  it("rejects an unresolved promotion intent", async () => {
    // Given
    const databasePath = await seededDatabase();
    insertTransition(databasePath, "native_project_root_promotion_intent", {
      sequence: 1,
      expectedCommit: initialCommit,
      candidateCommit,
      candidateTree,
      transitionPolicyDigest: policyDigest
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(() => assertNativeProjectRootPromotionRows(database)).toThrow(/evidence is not yet verified/);
    database.close();

    // When / Then
    expect(() => readNativeProjectRootCurrentHeadFromDatabase(databasePath, projectId)).toThrow(/unresolved/i);
  });

  it("rejects a broken finalized chain during startup row inspection", async () => {
    // Given
    const databasePath = await seededDatabase();
    insertTransition(databasePath, "native_project_root_promotion_finalized", {
      sequence: 2, expectedCommit: initialCommit, candidateCommit, candidateTree,
      transitionPolicyDigest: policyDigest
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });

    // When / Then
    try {
      expect(() => assertNativeProjectRootPromotionRows(database)).toThrow(/chain/i);
    } finally {
      database.close();
    }
  });

  it("rejects a transition whose commit and tree object formats differ", async () => {
    // Given
    const databasePath = await seededDatabase();
    insertTransition(databasePath, "native_project_root_promotion_finalized", {
      sequence: 1,
      expectedCommit: initialCommit,
      candidateCommit: "c".repeat(64),
      candidateTree: "d".repeat(64),
      transitionPolicyDigest: policyDigest
    });

    // When / Then
    expect(() => readNativeProjectRootCurrentHeadFromDatabase(databasePath, projectId)).toThrow(/object formats/i);
  });

  it.each([
    ["import nonce", { transitionImportNonce: "22222222-2222-4222-8222-222222222222" }],
    ["transition identity", { transitionId: "9".repeat(64) }],
    ["evidence digest", { transitionEvidenceDigest: "a".repeat(64) }]
  ])("rejects an altered %s", async (_label, altered) => {
    // Given
    const databasePath = await seededDatabase();
    insertTransition(databasePath, "native_project_root_promotion_finalized", {
      sequence: 1, expectedCommit: initialCommit, candidateCommit, candidateTree,
      transitionPolicyDigest: policyDigest, ...altered
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });

    // When / Then
    try {
      expect(() => assertNativeProjectRootPromotionRows(database)).toThrow();
    } finally {
      database.close();
    }
  });

  it("rejects evidence whose execution kind differs from imported policy", async () => {
    // Given
    const databasePath = await seededDatabase();
    const alteredEvidence = { ...promotionEvidence, jobs: [
      { ...promotionEvidence.jobs[1], executionKind: "ordinary-sysbox" as const },
      promotionEvidence.jobs[0]
    ] };
    insertTransition(databasePath, "native_project_root_promotion_finalized", {
      sequence: 1, expectedCommit: initialCommit, candidateCommit, candidateTree,
      transitionPolicyDigest: policyDigest, evidence: alteredEvidence
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });

    // When / Then
    try {
      expect(() => assertNativeProjectRootPromotionRows(database)).toThrow(/chain/i);
    } finally {
      database.close();
    }
  });
});

async function seededDatabase(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-promotion-state-"));
  roots.push(root);
  const databasePath = join(root, "state.sqlite3");
  const database = createNativeGitBundleDatabase(databasePath);
  database.prepare("INSERT INTO bundle_activation (generation_id, activation_token_sha256) VALUES (?, ?)")
    .run("1".repeat(64), "2".repeat(64));
  database.prepare(`INSERT INTO native_project_registration
    (service_id, project_id, root_repository_id, owner_host_id, provisioning_nonce, phase)
    VALUES ('native-main', ?, 'root', 'host-a', ?, 'root-prepared')`).run(projectId, randomUUID());
  database.prepare(`INSERT INTO native_project_root_import
    (project_id, service_id, root_repository_id, owner_host_id, generation_id, import_nonce,
      protected_ref, expected_commit, policy_json, policy_sha256, bundle_sha256, bundle_size,
      resolved_tree, phase)
    VALUES (?, 'native-main', 'root', 'host-a', ?, ?, ?, ?, ?, ?, ?, 1, ?, 'root-imported')`)
    .run(projectId, decisionGeneration, importNonce, protectedRef, initialCommit, policyJson,
      policyDigest, "3".repeat(64), initialTree);
  database.close();
  return databasePath;
}

type TransitionFixture = {
  readonly sequence: number; readonly expectedCommit: string;
  readonly candidateCommit: string; readonly candidateTree: string;
  readonly transitionPolicyDigest: string;
  readonly transitionImportNonce?: string; readonly transitionId?: string;
  readonly transitionEvidenceDigest?: string; readonly evidence?: NativeProjectRootPromotionEvidence;
};

function insertTransition(
  databasePath: string,
  table: "native_project_root_promotion_finalized" | "native_project_root_promotion_intent",
  fixture: TransitionFixture
): void {
  const evidence = fixture.evidence ?? promotionEvidence;
  const evidenceJson = JSON.stringify(evidence);
  const evidenceDigest = fixture.transitionEvidenceDigest
    ?? nativeProjectRootPromotionEvidenceDigest(evidence);
  const identity: Omit<NativeProjectRootPromotionTransition, "transitionId" | "evidence"> = {
    projectId,
    importNonce: fixture.transitionImportNonce ?? importNonce,
    sequence: fixture.sequence,
    reviewId: evidence.reviewId,
    protectedRef,
    proposalRef,
    expectedCommit: fixture.expectedCommit,
    expectedTree: initialTree,
    candidateCommit: fixture.candidateCommit,
    candidateTree: fixture.candidateTree,
    decisionGeneration,
    policyDigest: fixture.transitionPolicyDigest,
    policyRevision: policy.policyRevision,
    requiredReviewRevision: policy.requiredReviewRevision,
    requiredJobSetRevision: policy.requiredJobSetRevision,
    evidenceDigest
  };
  const database = new DatabaseSync(databasePath);
  if (fixture.transitionImportNonce !== undefined) database.exec("PRAGMA foreign_keys = OFF");
  database.prepare(`INSERT INTO ${table}
    (project_id, transition_id, import_nonce, sequence, review_id, protected_ref, proposal_ref,
      expected_commit, expected_tree, candidate_commit, candidate_tree, decision_generation,
      policy_sha256, policy_revision, required_review_revision, required_job_set_revision,
      evidence_json, evidence_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(projectId, fixture.transitionId ?? nativeProjectRootPromotionTransitionId(identity),
      identity.importNonce, identity.sequence, identity.reviewId, identity.protectedRef, identity.proposalRef,
      identity.expectedCommit, identity.expectedTree, identity.candidateCommit, identity.candidateTree,
      identity.decisionGeneration, identity.policyDigest, identity.policyRevision,
      identity.requiredReviewRevision, identity.requiredJobSetRevision, evidenceJson, identity.evidenceDigest);
  database.close();
}
