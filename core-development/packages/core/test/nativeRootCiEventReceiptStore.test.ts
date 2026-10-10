import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNativeRootCiEventReceiptRequest } from "../../../../core/packages/core/src/nativeRootCiEventReceiptModel.js";
import { NativeRootCiEventReceiptStore } from "../../../../core/packages/core/src/nativeRootCiEventReceiptStore.js";
import type { NativeRootCiPolicyProof, NativeRootCiReviewEventProof } from "../../../../core/packages/core/src/nativeRootCiProofModel.js";
import { openNativeRootAdmissionDatabase } from "../../../../core/packages/core/src/nativeRootAdmissionSchema.js";
import { NativeRootAdmissionStore } from "../../../../core/packages/core/src/nativeRootAdmissionStore.js";

const generationId = "a".repeat(64);
const capacityDigest = "c".repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native root CI event receipt store", () => {
  it("checks exact replay before cap and rejects changed reuse, unseen input, and inactive admission", async () => {
    // Given
    const fixture = await setup();
    const request = receiptRequest(fixture.admissionGeneration, event("1".repeat(64)));
    fixture.receipts.commit(request, eventProof(request.event));
    fillReceiptCapacity(fixture);

    // When
    const exact = fixture.receipts.preflight(request);
    const changed = fixture.receipts.preflight(receiptRequest(fixture.admissionGeneration,
      { ...request.event, candidateTree: "5".repeat(40) }));
    const unseen = fixture.receipts.preflight(receiptRequest(fixture.admissionGeneration, event("2".repeat(64))));
    fixture.admissions.revoke("project-a", fixture.admissionGeneration);
    const inactive = fixture.receipts.preflight(request);

    // Then
    expect([exact.kind, changed.kind, unseen.kind, inactive.kind]).toEqual(["replay", "conflict", "full", "not-found"]);
    expect(receiptCount(fixture)).toBe(100_000);
  });

  it("conflicts on root advance or expiry but accepts a lease-only renewal", async () => {
    // Given
    const stale = await setup();
    const staleRequest = receiptRequest(stale.admissionGeneration, event("3".repeat(64)));
    expect(stale.receipts.preflight(staleRequest).kind).toBe("ready");
    stale.database.prepare(`UPDATE native_root_admissions SET root_sequence = 1, root_commit = ?, root_tree = ?
      WHERE admission_generation = ?`).run("6".repeat(40), "7".repeat(40), stale.admissionGeneration);
    const renewed = await setup();
    const renewedRequest = receiptRequest(renewed.admissionGeneration, event("4".repeat(64)));
    expect(renewed.receipts.preflight(renewedRequest).kind).toBe("ready");
    renewed.database.prepare(`UPDATE native_root_admissions SET lease_expires_at = lease_expires_at + 1000
      WHERE admission_generation = ?`).run(renewed.admissionGeneration);
    const expired = await setup();
    const expiredRequest = receiptRequest(expired.admissionGeneration, event("7".repeat(64)));
    expired.database.prepare(`UPDATE native_root_admissions SET lease_expires_at = ?
      WHERE admission_generation = ?`).run(1_000, expired.admissionGeneration);

    // When
    const advanced = stale.receipts.commit(staleRequest, eventProof(staleRequest.event));
    const leaseOnly = renewed.receipts.commit(renewedRequest, eventProof(renewedRequest.event));

    // Then
    expect(advanced.kind).toBe("conflict");
    expect(leaseOnly.kind).toBe("replay");
    expect(expired.receipts.preflight(expiredRequest).kind).toBe("not-found");
    expect(receiptCount(stale)).toBe(0);
    expect(receiptCount(renewed)).toBe(1);
  });

  it("rolls back a failed receipt insert and converges an exact concurrent winner", async () => {
    // Given
    const rejected = await setup();
    const rejectedRequest = receiptRequest(rejected.admissionGeneration, event("5".repeat(64)));
    rejected.database.exec(`CREATE TRIGGER reject_event_receipt BEFORE INSERT ON native_root_ci_event_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END`);
    const demandRejected = await setup();
    const demandRejectedRequest = receiptRequest(demandRejected.admissionGeneration, event("d".repeat(64)));
    demandRejected.database.exec(`CREATE TRIGGER reject_demand BEFORE INSERT ON native_root_ci_demands
      BEGIN SELECT RAISE(ABORT, 'demand rejected'); END`);
    const converged = await setup();
    const convergedRequest = receiptRequest(converged.admissionGeneration, event("6".repeat(64)));

    // When / Then
    expect(() => rejected.receipts.commit(rejectedRequest, eventProof(rejectedRequest.event))).toThrow(/receipt rejected/i);
    expect(() => demandRejected.receipts.commit(demandRejectedRequest,
      eventProof(demandRejectedRequest.event))).toThrow(/demand rejected/i);
    expect(receiptCount(rejected)).toBe(0);
    expect(demands(rejected)).toEqual([]);
    expect(receiptCount(demandRejected)).toBe(0);
    expect(demands(demandRejected)).toEqual([]);
    expect(converged.receipts.commit(convergedRequest, eventProof(convergedRequest.event)).kind).toBe("replay");
    expect(converged.receipts.commit(convergedRequest, eventProof(convergedRequest.event)).kind).toBe("replay");
    expect(receiptCount(converged)).toBe(1);
    expect(demands(converged)).toEqual([{
      admissionGeneration: converged.admissionGeneration,
      eventId: convergedRequest.event.eventId,
      reviewId: convergedRequest.event.reviewId,
      state: "queued"
    }]);
  });

  it("never requeues an exact receipt replay after its demand is superseded", async () => {
    // Given
    const fixture = await setup();
    const request = receiptRequest(fixture.admissionGeneration, event("8".repeat(64)));
    fixture.receipts.commit(request, eventProof(request.event));
    const moved = policyProof();
    fixture.admissions.register({ ...moved, currentRoot: { ...moved.currentRoot, sequence: 1,
      commit: "6".repeat(40), tree: "7".repeat(40) } });

    // When
    const replay = fixture.receipts.commit(request, eventProof(request.event));

    // Then
    expect(replay.kind).toBe("replay");
    expect(receiptCount(fixture)).toBe(1);
    expect(demands(fixture)).toEqual([{
      admissionGeneration: fixture.admissionGeneration,
      eventId: request.event.eventId,
      reviewId: request.event.reviewId,
      state: "superseded"
    }]);
  });

  it("refuses to acknowledge an existing receipt whose paired demand disappeared", async () => {
    // Given
    const fixture = await setup();
    const request = receiptRequest(fixture.admissionGeneration, event("e".repeat(64)));
    fixture.receipts.commit(request, eventProof(request.event));
    fixture.database.prepare("DELETE FROM native_root_ci_demands").run();

    // When / Then
    expect(() => fixture.receipts.preflight(request)).toThrow(/event receipt/i);
    expect(receiptCount(fixture)).toBe(1);
    expect(demands(fixture)).toEqual([]);
  });

  it("supersedes queued demands on expiry, admission replacement, generation rotation, and capacity rotation", async () => {
    // Given
    const expired = await setup();
    commitEvent(expired, "9".repeat(64));
    expired.database.prepare("UPDATE native_root_admissions SET lease_expires_at = 1000").run();
    const replaced = await setup();
    commitEvent(replaced, "a".repeat(64));
    const generationRotated = await setup();
    commitEvent(generationRotated, "b".repeat(64));
    const capacityRotated = await setup();
    commitEvent(capacityRotated, "c".repeat(64));

    // When
    expired.admissions.current("project-a", expired.admissionGeneration);
    const replacement = policyProof();
    replaced.admissions.register({ ...replacement, currentRoot: {
      ...replacement.currentRoot, importNonce: "00000000-0000-4000-8000-000000000099" } });
    new NativeRootAdmissionStore(generationRotated.database, { ...generationRotated.admissions.context,
      controlPlaneGenerationId: "b".repeat(64) }).activate();
    new NativeRootAdmissionStore(capacityRotated.database, { ...capacityRotated.admissions.context,
      capacityConfigDigest: "d".repeat(64) }).activate();

    // Then
    expect([expired, replaced, generationRotated, capacityRotated]
      .map((fixture) => demands(fixture).map(({ state }) => state))).toEqual([
        ["superseded"], ["superseded"], ["superseded"], ["superseded"]
      ]);
  });
});

type Fixture = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dim-event-receipt-store-"));
  roots.push(root);
  const database = openNativeRootAdmissionDatabase(join(root, "ordinary.sqlite3"));
  const now = () => 1_000;
  const admissions = new NativeRootAdmissionStore(database, { ordinaryServiceId: "ordinary-main",
    controlPlaneGenerationId: generationId, capacityConfigDigest: capacityDigest,
    leaseMilliseconds: 10_000, now });
  const registered = admissions.register(policyProof());
  if (registered.kind !== "registered") throw new TypeError("admission registration conflicted");
  const receipts = new NativeRootCiEventReceiptStore(database, { ordinaryServiceId: "ordinary-main",
    controlPlaneGenerationId: generationId, capacityConfigDigest: capacityDigest,
    activated: () => true, activationBound: () => true, now });
  return { database, admissions, receipts, admissionGeneration: registered.admission.admissionGeneration };
}

function policyProof(): NativeRootCiPolicyProof {
  const requiredJobs = [{ name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }] as const;
  const reviewers = { requiredReviewerIds: ["owner"], pathReviewerRules: [] } as const;
  const requiredReviewRevision = revision("reviewers", 1, reviewers);
  const requiredJobSetRevision = revision("jobs", 2, requiredJobs);
  const policy = { schemaVersion: 1 as const, protectedRef: "refs/heads/main",
    policyRevision: revision("policy", 2, { protectedRef: "refs/heads/main", ...reviewers, requiredJobs }),
    requiredReviewRevision, requiredJobSetRevision, requiredJobs, ...reviewers };
  return { schemaVersion: 1, serviceId: "native-main", requestId: "00000000-0000-4000-8000-000000000010",
    servingGenerationId: generationId, projectId: "project-a", repositoryId: "root", currentRoot: {
      importNonce: "00000000-0000-4000-8000-000000000011", sequence: 0, protectedRef: "refs/heads/main",
      commit: "1".repeat(40), tree: "2".repeat(40),
      policyDigest: createHash("sha256").update(JSON.stringify(policy)).digest("hex") }, policy };
}

function event(reviewId: string) {
  const policy = policyProof().policy;
  const eventId = createHash("sha256").update("dim-native-authoritative-review-event-v1\0")
    .update(JSON.stringify({ executionKind: "ordinary-sysbox", jobName: "source", reviewId })).digest("hex");
  return { schemaVersion: 2 as const, type: "dim.native.review-job.available" as const, eventId,
    projectId: "project-a", repositoryId: "root" as const, protectedRef: "refs/heads/main", reviewId,
    expectedProtectedHead: "1".repeat(40), candidateCommit: "3".repeat(40), candidateTree: "4".repeat(40),
    policyRevision: policy.policyRevision, requiredReviewRevision: policy.requiredReviewRevision,
    requiredJobSetRevision: policy.requiredJobSetRevision, executionKind: "ordinary-sysbox" as const,
    jobName: "source", evidenceClass: "candidate-controlled" as const };
}

function receiptRequest(admissionGeneration: string, reviewEvent: ReturnType<typeof event>) {
  return parseNativeRootCiEventReceiptRequest({ schemaVersion: 1, generationId, admissionGeneration, event: reviewEvent });
}
function eventProof(reviewEvent: ReturnType<typeof event>): NativeRootCiReviewEventProof {
  return { ...policyProof(), reviewLiveness: "current", event: reviewEvent };
}
function revision(domain: string, version: number, value: unknown): string {
  return createHash("sha256").update(`dim-native-${domain}-v${version}\0`).update(JSON.stringify(value)).digest("hex");
}
function fillReceiptCapacity(fixture: Fixture): void {
  const request = receiptRequest(fixture.admissionGeneration, event("1".repeat(64)));
  fixture.database.exec(`WITH RECURSIVE values_(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM values_ WHERE value < 99999)
    INSERT INTO native_root_ci_event_receipts SELECT '${fixture.admissionGeneration}', printf('%064x', value),
    '${request.eventDigest}', '${request.canonicalEvent.replaceAll("'", "''")}', 'ordinary-main', '${generationId}',
    'native-main', 'project-a', 'root', '00000000-0000-4000-8000-000000000011',
    '${policyProof().currentRoot.policyDigest}', 0, 'refs/heads/main', '${"1".repeat(40)}', '${"2".repeat(40)}',
    '${capacityDigest}', 1000 FROM values_`);
}
function receiptCount(fixture: Fixture): number {
  return Number(fixture.database.prepare("SELECT COUNT(*) AS value FROM native_root_ci_event_receipts").get()?.value);
}
function demands(fixture: Fixture): readonly Readonly<Record<string, string>>[] {
  return fixture.database.prepare(`SELECT admission_generation, event_id, review_id, state
    FROM native_root_ci_demands ORDER BY created_at, demand_id`).all().map((row) => ({
      admissionGeneration: String(row.admission_generation),
      eventId: String(row.event_id),
      reviewId: String(row.review_id),
      state: String(row.state)
    }));
}
function commitEvent(fixture: Fixture, reviewId: string): void {
  const request = receiptRequest(fixture.admissionGeneration, event(reviewId));
  fixture.receipts.commit(request, eventProof(request.event));
}
