import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNativeRootAdmissionDatabase } from "../../../../core/packages/core/src/nativeRootAdmissionSchema.js";
import { NativeRootAdmissionStore } from "../../../../core/packages/core/src/nativeRootAdmissionStore.js";
import { createNativeRootCiProofClient } from "../../../../core/packages/core/src/nativeRootCiProofClient.js";
import type { NativeRootCiPolicyProof } from "../../../../core/packages/core/src/nativeRootCiProofModel.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import { createBundleReview, nativeBundleReviewFixture } from "../../native-git/test/nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";

const roots: string[] = [];

afterEach(async () => {
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native root admission durable lifecycle", () => {
  it("renews only monotonic roots and regenerates after policy, import, revocation, and expiry changes", async () => {
    // Given
    const proof = await realProof("admission-store-lifecycle");
    const root = await temporaryRoot();
    const database = openNativeRootAdmissionDatabase(join(root, "ordinary.sqlite3"));
    let now = 1_000;
    const store = new NativeRootAdmissionStore(database, context(() => now));

    // When
    const first = registered(store.register(proof));
    now = 2_000;
    const advancedProof = withRoot(proof, { sequence: proof.currentRoot.sequence + 1,
      commit: "a".repeat(proof.currentRoot.commit.length), tree: "b".repeat(proof.currentRoot.tree.length) });
    const renewed = registered(store.register(advancedProof));
    const leaseBeforeConflicts = renewed.expiresAt;
    now = 3_000;
    const lower = store.register(proof);
    const changedSameSequence = store.register(withRoot(advancedProof,
      { commit: "c".repeat(proof.currentRoot.commit.length) }));
    const leaseAfterConflicts = store.current(proof.projectId, first.admissionGeneration)?.expiresAt;
    const changedPolicy = registered(store.register(withPolicy(advancedProof)));
    const changedImport = registered(store.register(withRoot(withPolicy(advancedProof), { importNonce: crypto.randomUUID() })));
    store.revoke(proof.projectId, changedImport.admissionGeneration);
    const afterRevocation = registered(store.register(withRoot(advancedProof, { importNonce: crypto.randomUUID() })));
    now = afterRevocation.expiresAt;
    const expired = store.current(proof.projectId, afterRevocation.admissionGeneration);
    const afterExpiry = registered(store.register(withRoot(advancedProof, { importNonce: crypto.randomUUID() })));

    // Then
    expect(renewed.admissionGeneration).toBe(first.admissionGeneration);
    expect([lower.kind, changedSameSequence.kind]).toEqual(["conflict", "conflict"]);
    expect(leaseAfterConflicts).toBe(leaseBeforeConflicts);
    expect(new Set([first.admissionGeneration, changedPolicy.admissionGeneration, changedImport.admissionGeneration,
      afterRevocation.admissionGeneration, afterExpiry.admissionGeneration]).size).toBe(5);
    expect(expired).toBeUndefined();
    expect(states(database)).toEqual(["replaced", "replaced", "revoked", "expired", "active"]);
    database.close();
  });

  it("replaces active rows on generation or global capacity rotation and rollback never revives them", async () => {
    // Given
    const proof = await realProof("admission-store-rotation");
    const root = await temporaryRoot();
    const database = openNativeRootAdmissionDatabase(join(root, "ordinary.sqlite3"));
    const firstStore = new NativeRootAdmissionStore(database, context(() => 1_000));
    const first = registered(firstStore.register(proof));

    // When
    const nextGeneration = new NativeRootAdmissionStore(database, {
      ...context(() => 2_000), controlPlaneGenerationId: "b".repeat(64)
    });
    nextGeneration.activate();
    const second = registered(nextGeneration.register({ ...proof, servingGenerationId: "b".repeat(64) }));
    const nextCapacity = new NativeRootAdmissionStore(database, {
      ...context(() => 3_000), controlPlaneGenerationId: "b".repeat(64), capacityConfigDigest: "d".repeat(64)
    });
    nextCapacity.activate();
    const rolledBack = new NativeRootAdmissionStore(database, context(() => 4_000));
    rolledBack.activate();

    // Then
    expect(first.admissionGeneration).not.toBe(second.admissionGeneration);
    expect(rolledBack.current(proof.projectId, first.admissionGeneration)).toBeUndefined();
    expect(rolledBack.current(proof.projectId, second.admissionGeneration)).toBeUndefined();
    expect(states(database)).toEqual(["replaced", "replaced"]);
    database.close();
  });

  it("refuses a new durable request after the exact 100000-row replay cap", async () => {
    // Given
    const root = await temporaryRoot();
    const database = openNativeRootAdmissionDatabase(join(root, "ordinary.sqlite3"));
    database.exec(`WITH RECURSIVE requests(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM requests WHERE value < 100000
    ) INSERT INTO native_root_admission_requests
      (request_id, operation, tuple_digest, status_code, response_json, created_at)
      SELECT printf('%032x', value), 'current', printf('%064x', value), 200, '{}', 1 FROM requests`);
    const store = new NativeRootAdmissionStore(database, context(() => 1_000));

    // When / Then
    expect(store.hasRequestCapacity()).toBe(false);
    database.close();
  });
});

async function realProof(label: string): Promise<NativeRootCiPolicyProof> {
  const fixture = await nativeBundleReviewFixture(label);
  await createBundleReview(fixture.service);
  return createNativeRootCiProofClient({ endpoint: fixture.service.origin, serviceId: "native-main", generationId,
    identity: { username: "ordinary-identity", password: bundleSecrets.nativeIdentity } })
    .readImportedPolicy("project-a", AbortSignal.timeout(5_000));
}
function context(now: () => number) {
  return { ordinaryServiceId: "ordinary-main", controlPlaneGenerationId: generationId,
    capacityConfigDigest: "c".repeat(64), leaseMilliseconds: 10_000, now } as const;
}
function withRoot(proof: NativeRootCiPolicyProof,
  patch: Partial<NativeRootCiPolicyProof["currentRoot"]>): NativeRootCiPolicyProof {
  return { ...proof, currentRoot: { ...proof.currentRoot, ...patch } };
}
function withPolicy(proof: NativeRootCiPolicyProof): NativeRootCiPolicyProof {
  const requiredReviewerIds = [...proof.policy.requiredReviewerIds, "reviewer-b"].sort();
  const reviewers = { requiredReviewerIds, pathReviewerRules: proof.policy.pathReviewerRules };
  const requiredReviewRevision = revision("reviewers", 1, reviewers);
  const policy = { ...proof.policy, requiredReviewerIds, requiredReviewRevision,
    policyRevision: revision("policy", 2, { protectedRef: proof.policy.protectedRef,
      ...reviewers, requiredJobs: proof.policy.requiredJobs }) };
  return { ...proof, policy, currentRoot: { ...proof.currentRoot,
    policyDigest: createHash("sha256").update(JSON.stringify(policy)).digest("hex") } };
}
function revision(domain: "policy" | "reviewers", version: 1 | 2, value: unknown): string {
  return createHash("sha256").update(`dim-native-${domain}-v${version}\0`).update(JSON.stringify(value)).digest("hex");
}
function registered(result: ReturnType<NativeRootAdmissionStore["register"]>) {
  if (result.kind !== "registered") throw new TypeError("registration unexpectedly conflicted");
  return result.admission;
}
function states(database: import("node:sqlite").DatabaseSync): readonly string[] {
  return database.prepare("SELECT state FROM native_root_admissions ORDER BY created_at, rowid").all()
    .map((row) => String(row.state));
}
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-admission-store-"));
  roots.push(root);
  return root;
}
