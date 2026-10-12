import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resultRequest } from "../../core/test/nativeRootHostResultFixture.js";
import {
  cleanupNativeOrdinaryTerminalFixtures,
  createActiveAttempt,
  nativeOrdinaryTerminalFixture,
  type NativeOrdinaryTerminalFixture
} from "./nativeOrdinaryTerminalEvidenceFixture.js";
import {
  cleanupFinalizeFixtures,
  generationId,
  hostPromoterAuthorization,
  humanReviewerAuthorization,
  rootRepository,
  runGit
} from "./nativeRootImportFinalizeFixture.js";
import { authoritativePolicy } from "./authoritativeNativeCandidateFixture.js";
import { statusRecordPath } from "./nativeOrdinaryStatusFixture.js";
import { bundleSecrets } from "./bundleConfigFixture.js";

afterEach(async () => {
  await cleanupNativeOrdinaryTerminalFixtures();
  await cleanupFinalizeFixtures();
});

describe("installed two-service ordinary terminal evidence", () => {
  it("returns exact success evidence after delivered release and ordinary restart without native writes", async () => {
    // Given
    const fixture = await nativeOrdinaryTerminalFixture("ordinary-terminal-installed");
    const active = await createActiveAttempt(fixture);
    const result = resultRequest(active.claim, active.issuance, "941");
    expect((await hostResult(fixture.ordinaryOrigin, result)).status).toBe(202);
    await waitFor(() => terminalState(fixture.database).outbox === "delivered");
    const restarted = await fixture.restartOrdinary();
    const before = await nativeSnapshot(restarted.nativeRoot, restarted.reviewId);

    // When
    const evidence = await restarted.native.currentOrdinaryTerminalEvidence({
      projectId: "project-a",
      reviewId: restarted.reviewId,
      jobName: "source"
    });

    // Then
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      executionKind: "ordinary-sysbox",
      evidenceClass: "candidate-controlled",
      projectId: "project-a",
      repositoryId: "root",
      reviewId: restarted.reviewId,
      jobName: "source",
      attemptId: active.issuance.attemptId,
      result: "success",
      completion: { kind: "exited", exitCode: 0 },
      provenance: {
        ordinaryServiceId: "ordinary-main",
        resultGenerationId: "a".repeat(64),
        cleanupResourceId: active.claim.claimId,
        cleanupComplete: true
      }
    });
    expect(evidence.provenance.statusAcknowledgementJson)
      .toBe((await readFile(statusRecordPath(restarted.nativeRoot, restarted.reviewId), "utf8")));
    expect(await nativeSnapshot(restarted.nativeRoot, restarted.reviewId)).toEqual(before);
  }, 45_000);

  it("rejects a pending ordinary delivery without native mutation", async () => {
    // Given
    const fixture = await nativeOrdinaryTerminalFixture("ordinary-terminal-pending", false);
    const active = await createActiveAttempt(fixture);
    const result = resultRequest(active.claim, active.issuance, "942");
    expect((await hostResult(fixture.ordinaryOrigin, result)).status).toBe(202);
    await waitFor(() => terminalState(fixture.database).outbox === "pending");
    const before = await nativeSnapshotWithoutStatus(fixture.nativeRoot);

    // When
    const operation = fixture.native.currentOrdinaryTerminalEvidence({
      projectId: "project-a",
      reviewId: fixture.reviewId,
      jobName: "source"
    });

    // Then
    await expect(operation).rejects.toThrow();
    expect(await nativeSnapshotWithoutStatus(fixture.nativeRoot)).toEqual(before);
  }, 45_000);

  it("rejects revoked and expired ordinary admission after delivery without native mutation", async () => {
    // Given
    const revoked = await deliveredFixture("ordinary-terminal-admission-revoked", "943");
    const expired = await deliveredFixture("ordinary-terminal-admission-expired", "944");
    updateAdmission(revoked.database, "revoked");
    updateAdmission(expired.database, "expired");
    const revokedBefore = await nativeSnapshot(revoked.nativeRoot, revoked.reviewId);
    const expiredBefore = await nativeSnapshot(expired.nativeRoot, expired.reviewId);

    // When
    const outcomes = await Promise.allSettled([currentEvidence(revoked), currentEvidence(expired)]);

    // Then
    expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    expect(await nativeSnapshot(revoked.nativeRoot, revoked.reviewId)).toEqual(revokedBefore);
    expect(await nativeSnapshot(expired.nativeRoot, expired.reviewId)).toEqual(expiredBefore);
  }, 60_000);

  it("promotes only after the policy-selected ordinary result is durably delivered", async () => {
    // Given
    const policy = authoritativePolicy(["owner"], [], [
      { name: "source", kind: "ordinary-sysbox", evidenceClass: "candidate-controlled" }
    ]);
    const runner = `schemaVersion: 4
ordinary:
  jobs:
    source:
      script: .dim/ci/jobs/source.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
qemu:
  jobs: {}
`;
    const fixture = await nativeOrdinaryTerminalFixture("ordinary-terminal-promotion", true, policy, runner);
    const active = await createActiveAttempt(fixture);
    expect((await hostResult(fixture.ordinaryOrigin, resultRequest(active.claim, active.issuance, "945"))).status)
      .toBe(202);
    await waitFor(() => terminalState(fixture.database).outbox === "delivered");
    const approved = await reviewPost(fixture.native.origin,
      `/v1/projects/project-a/repositories/root/reviews/${fixture.reviewId}/approvals`,
      humanReviewerAuthorization, { requestId: randomUUID() });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);

    // When
    const promoted = await reviewPost(fixture.native.origin,
      `/v1/projects/project-a/repositories/root/reviews/${fixture.reviewId}/promotions`,
      hostPromoterAuthorization, { schemaVersion: 1 });

    // Then
    expect(promoted.status).toBe(201);
    expect(promoted.body).toMatchObject({ outcome: "promoted", reviewId: fixture.reviewId, sequence: 1 });
  }, 45_000);
});

async function deliveredFixture(label: string, suffix: string) {
  const fixture = await nativeOrdinaryTerminalFixture(label);
  const active = await createActiveAttempt(fixture);
  expect((await hostResult(fixture.ordinaryOrigin, resultRequest(active.claim, active.issuance, suffix))).status).toBe(202);
  await waitFor(() => terminalState(fixture.database).outbox === "delivered");
  return fixture;
}

function currentEvidence(fixture: NativeOrdinaryTerminalFixture) {
  return fixture.native.currentOrdinaryTerminalEvidence({
    projectId: "project-a",
    reviewId: fixture.reviewId,
    jobName: "source"
  });
}

function updateAdmission(file: string, state: "revoked" | "expired"): void {
  const database = new DatabaseSync(file);
  try {
    switch (state) {
      case "revoked":
        database.prepare("UPDATE native_root_admissions SET state = 'revoked'").run();
        break;
      case "expired":
        database.prepare("UPDATE native_root_admissions SET lease_expires_at = 1").run();
        break;
      default:
        assertNever(state);
    }
  } finally { database.close(); }
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected admission state: ${value}`);
}

function hostResult(origin: string, body: object): Promise<Response> {
  return fetch(`${origin}/v1/host-results`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`host-a:${bundleSecrets.host}`).toString("base64")}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function reviewPost(origin: string, path: string, authorization: string, body: object) {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: {
    authorization, "content-type": "application/json", "x-dim-generation-id": generationId
  }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

function terminalState(file: string): { readonly outbox: string } {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return { outbox: String(database.prepare("SELECT state FROM native_root_ci_report_outbox").get()?.state) }; }
  finally { database.close(); }
}

async function nativeSnapshot(root: string, reviewId: string) {
  return {
    ...(await nativeSnapshotWithoutStatus(root)),
    status: await readFile(statusRecordPath(root, reviewId))
  };
}

async function nativeSnapshotWithoutStatus(root: string) {
  return {
    database: await readFile(`${root}/.dim-native-git-owner.sqlite3`),
    refs: (await runGit("/usr/bin/git", ["--git-dir", rootRepository(root), "show-ref"])).stdout
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not observed");
}
