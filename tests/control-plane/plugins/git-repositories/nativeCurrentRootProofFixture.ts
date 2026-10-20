import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { saveRepositoryRefIntent, finalizeRepositoryRef, type RepositoryRefTransition } from "../../../../packages/control-plane/plugins/git-repositories/src/repository-ref-state.js";
import { generationId, rootRepository, runGit } from "./nativeRootImportFinalizeFixture.js";
import { reviewProposalRef } from "../git-ci/nativeBundleReviewFixture.js";

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
    const transition: RepositoryRefTransition = {
      projectId: "project-a", repositoryId: "root", importNonce: stringField(imported, "import_nonce"),
      sequence: 1, protectedRef: "refs/heads/main", proposalRef: reviewProposalRef,
      expectedCommit: stringField(imported, "expected_commit"), expectedTree: stringField(imported, "resolved_tree"),
      candidateCommit: input.candidateCommit, candidateTree: input.recordedCandidateTree ?? input.candidateTree,
      generationId, refPolicyRevision: "e".repeat(64), policyDigest: stringField(imported, "policy_sha256"),
      authorizationId: evidenceIdentity("authorization", "fixture"), evidenceDigest: evidenceIdentity("decision", "fixture")
    };
    saveRepositoryRefIntent(databasePath, transition);
    if (input.phase !== "intent") finalizeRepositoryRef(databasePath, transition);
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
