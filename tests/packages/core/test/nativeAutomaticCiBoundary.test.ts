import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeGitCandidateReadAuthority } from "../../../../core/packages/managed/src/nativeGitCandidateReadAuthority.js";
import type { NativeJobAttemptIssuance } from "../../../../core/packages/managed/src/nativeGitAttemptIssuerModel.js";
import { createNativeRootCiHostClient } from "../../../../core/packages/managed/src/nativeRootCiHostClient.js";
import { NativeQemuHostClient, type NativeQemuHostAssignment } from "../../../../core/packages/managed/src/nativeQemuHostClient.js";
import { authoritativePolicy } from "../../native-git/test/authoritativeNativeCandidateFixture.js";
import { refreshBundleReviewWriter, reviewProposalRef } from "../../native-git/test/nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, generationId,
  runGit } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { nativeAutomaticCiFixture, ordinaryHostToken, qemuRequestId,
  type NativeAutomaticCiFixture } from "./nativeAutomaticCiFixture.js";

const fixtures: NativeAutomaticCiFixture[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await cleanupFinalizeFixtures();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("automatic native CI boundary", () => {
  it("schedules ordinary and QEMU candidate work from a real push without project-local admission", async () => {
    // Given
    const fixture = await nativeAutomaticCiFixture();
    fixtures.push(fixture);
    const signal = AbortSignal.timeout(40_000);
    const ordinary = createNativeRootCiHostClient({ hostId: "host-a", capacity: "primary", generationId,
      ordinaryCi: { endpoint: fixture.ordinaryOrigin, serviceId: "ordinary-main",
        credential: { username: "host-a", password: ordinaryHostToken("host-a") } },
      nativeGit: { endpoint: fixture.native.service.origin, serviceId: "native-main" } });
    const qemuHost = fixture.qemuConfig.hosts[0];
    if (qemuHost === undefined) throw new TypeError("QEMU host is missing");
    const qemu = qemuClient(fixture, qemuHost);

    // When
    await Promise.all([ordinary.attest(signal), qemu.attest(signal)]);
    const reservation = await ordinary.reserve(ordinary.prepareClaim(randomUUID()), signal);
    if (reservation === undefined) throw new TypeError("ordinary reservation is missing");
    const issuance = await ordinary.issue(reservation, signal);
    const active = await ordinary.activate(ordinary.prepareActivation(reservation, issuance, randomUUID()), signal);
    const ordinaryLease = await ordinary.candidateLease(active, randomUUID(), signal);
    const assignment = await qemu.claim(qemuRequestId(), signal);
    if (assignment === undefined) throw new TypeError("QEMU assignment is missing");
    const qemuLease = await qemu.candidateLease(assignment, signal);
    const ordinaryRoot = await materialize(fixture.native.service.origin, ordinaryLease, issuance.descriptor);
    const qemuRoot = await materialize(fixture.native.service.origin, qemuLease, assignment.attempt.descriptor);
    await Promise.all([
      ordinary.report(ordinary.prepareResult(ordinaryResult(active.claimId, issuance)), signal),
      qemu.report(qemuClaimString(assignment, "claimId"), qemuResult(assignment), signal)
    ]);
    await waitForResults(fixture, 1);
    await fixture.stopOrdinary();
    await writeFile(join(fixture.native.clone, ".dim/ci/runner.yml"), changedRunner());
    await writeFile(join(fixture.native.clone, ".dim/ci/jobs/check.bash"), "set -euo pipefail\nprintf 'check-v2\\n'\n");
    await writeFile(join(fixture.native.clone, ".dim/ci/jobs/source.bash"), "set -euo pipefail\nprintf 'source-v2\\n'\n");
    await runGit("/usr/bin/git", ["-C", fixture.native.clone, "add", ".dim/ci"]);
    await runGit("/usr/bin/git", ["-C", fixture.native.clone, "commit", "-m", "change candidate jobs"]);
    await refreshBundleReviewWriter(fixture.native);
    await runGit("/usr/bin/git", ["-C", fixture.native.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    await fixture.startOrdinary();
    const ordinaryB = createNativeRootCiHostClient({ hostId: "host-b", capacity: "backup", generationId,
      ordinaryCi: { endpoint: fixture.ordinaryOrigin, serviceId: "ordinary-main",
        credential: { username: "host-b", password: ordinaryHostToken("host-b") } },
      nativeGit: { endpoint: fixture.native.service.origin, serviceId: "native-main" } });
    await ordinaryB.attest(signal);
    const changedReservation = await reserveEventually(ordinaryB, signal);
    const changedIssuance = await ordinaryB.issue(changedReservation, signal);
    const changedActive = await ordinaryB.activate(
      ordinaryB.prepareActivation(changedReservation, changedIssuance, randomUUID()), signal);
    const changedLease = await ordinaryB.candidateLease(changedActive, randomUUID(), signal);
    const changedRoot = await materialize(
      fixture.native.service.origin, changedLease, changedIssuance.descriptor);
    const qemuHostB = fixture.qemuConfig.hosts[1];
    if (qemuHostB === undefined) throw new TypeError("second QEMU host is missing");
    const qemuB = qemuClient(fixture, qemuHostB);
    await qemuB.attest(signal);
    const changedQemuAssignment = await qemuClaimEventually(qemuB, signal);
    await ordinaryB.report(
      ordinaryB.prepareResult(ordinaryResult(changedActive.claimId, changedIssuance)), signal);
    await qemuB.recover(qemuClaimString(changedQemuAssignment, "claimId"), signal);
    await waitForResults(fixture, 2);
    await waitForEventCounts(fixture, { ordinary: 3, qemu: 2 });
    const countsBeforeInvalid = eventCounts(fixture);
    await writeFile(join(fixture.native.clone, ".dim/ci/runner.yml"), "schemaVersion: 4\nunknown: true\n");
    await runGit("/usr/bin/git", ["-C", fixture.native.clone, "add", ".dim/ci/runner.yml"]);
    await runGit("/usr/bin/git", ["-C", fixture.native.clone, "commit", "-m", "invalid candidate jobs"]);
    await refreshBundleReviewWriter(fixture.native);
    await runGit("/usr/bin/git", ["-C", fixture.native.clone, "push", "origin", `HEAD:${reviewProposalRef}`]);
    const persistedState = Buffer.concat([
      await readFile(fixture.ordinaryDatabase), await readFile(fixture.qemuDatabase)
    ]).toString("utf8");

    // Then
    expect(authoritativePolicy(["owner"], [], []).requiredJobs).toEqual([]);
    expect(reservation).toMatchObject({ hostId: "host-a", event: { executionKind: "ordinary-sysbox", jobName: "source" } });
    expect(assignment.claim).toMatchObject({ hostId: "qemu-a", event: { executionKind: "qemu", jobName: "integration" } });
    expect(await readFile(join(ordinaryRoot, ".dim/ci/jobs/source.bash"), "utf8"))
      .toBe("set -euo pipefail\nprintf 'source\\n'\n");
    expect(await readFile(join(qemuRoot, ".dim/ci/jobs/integration.bash"), "utf8"))
      .toBe("set -euo pipefail\nprintf 'integration\\n'\n");
    expect(changedReservation).toMatchObject({ hostId: "host-b",
      event: { executionKind: "ordinary-sysbox", jobName: "check" } });
    expect(await readFile(join(changedRoot, ".dim/ci/jobs/check.bash"), "utf8"))
      .toBe("set -euo pipefail\nprintf 'check-v2\\n'\n");
    expect(await readFile(join(changedRoot, ".dim/ci/jobs/source.bash"), "utf8"))
      .toBe("set -euo pipefail\nprintf 'source-v2\\n'\n");
    expect(changedQemuAssignment.claim).toMatchObject({ hostId: "qemu-b",
      event: { executionKind: "qemu", jobName: "integration" } });
    expect(eventCounts(fixture)).toEqual(countsBeforeInvalid);
    expect(JSON.stringify({ ordinaryLease, qemuLease, changedLease }))
      .not.toContain(ordinaryHostToken("host-a"));
    expect(persistedState).not.toContain(ordinaryHostToken("host-a"));
    expect(persistedState).not.toContain(ordinaryHostToken("host-b"));
    expect(persistedState).not.toContain(qemuHost.hostToken);
    expect(persistedState).not.toContain(qemuHostB.hostToken);
  }, 45_000);
});

async function materialize(origin: string, lease: { readonly username: string; readonly password: string },
  descriptor: { readonly projectId: string; readonly repositoryId: string; readonly protectedRef: string;
    readonly expectedProtectedHead: string; readonly candidateCommit: string; readonly candidateTree: string }): Promise<string> {
  const root = await mkdtemp("/tmp/dim-native-automatic-materialize-");
  roots.push(root);
  const destination = join(root, "workspace");
  const authority = createNativeGitCandidateReadAuthority({ gitExecutable: "/usr/bin/git", serviceEndpoint: origin,
    credential: lease, temporaryRoot: root, claim: descriptor });
  await authority.materializeTree({ projectId: descriptor.projectId, repositoryId: descriptor.repositoryId,
    commitObjectId: descriptor.candidateCommit, treeObjectId: descriptor.candidateTree,
    destination, signal: AbortSignal.timeout(20_000) });
  return destination;
}

async function reserveEventually(client: ReturnType<typeof createNativeRootCiHostClient>, signal: AbortSignal) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const reservation = await client.reserve(client.prepareClaim(randomUUID()), signal);
    if (reservation !== undefined) return reservation;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new TypeError("changed ordinary reservation is missing");
}

async function qemuClaimEventually(client: NativeQemuHostClient, signal: AbortSignal): Promise<NativeQemuHostAssignment> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const assignment = await client.claim(randomUUID(), signal);
    if (assignment !== undefined) return assignment;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new TypeError("changed QEMU assignment is missing");
}

function qemuClient(
  fixture: NativeAutomaticCiFixture,
  host: NativeAutomaticCiFixture["qemuConfig"]["hosts"][number]
): NativeQemuHostClient {
  return new NativeQemuHostClient({ schemaVersion: 1, hostId: host.hostId, generationId,
    gitExecutable: "/usr/bin/git", scheduler: { transport: "loopback-http", endpoint: fixture.qemuOrigin,
      serviceId: "qemu-main", hostToken: host.hostToken }, nativeGit: { transport: "loopback-http",
      endpoint: fixture.native.service.origin, serviceId: "native-main" }, capacities: [{ capacity: "kvm-main",
        runnerBaseImage: `registry.example/runner@sha256:${"1".repeat(64)}`,
        jobBaseImage: `registry.example/job@sha256:${"2".repeat(64)}`, cpus: 2, memoryBytes: 1048576,
        pids: 64, timeoutSeconds: 60, outputBytes: 1024 }] }, "kvm-main");
}

function changedRunner(): string {
  return `schemaVersion: 4
ordinary:
  jobs:
    check:
      script: .dim/ci/jobs/check.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
    source:
      script: .dim/ci/jobs/source.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
qemu:
  jobs:
    integration:
      script: .dim/ci/jobs/integration.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
`;
}

function ordinaryResult(claimId: string, issuance: NativeJobAttemptIssuance) {
  const timestamp = "2026-10-12T00:00:00.000Z";
  return { schemaVersion: 2, requestId: randomUUID(), generationId, claimId, resourceId: claimId,
    terminalEvent: { schemaVersion: 3, eventId: randomUUID(), occurredAt: timestamp,
      eventType: "dim.ci.job.completed", payload: { executionKind: "ordinary-sysbox",
        reviewId: issuance.reviewId, attemptId: issuance.attemptId, attempt: issuance.attempt,
        descriptor: issuance.descriptor, descriptorDigest: issuance.descriptorDigest,
        hostId: issuance.hostId, capacity: issuance.capacity, startedAt: timestamp, finishedAt: timestamp,
        result: "success", completion: { kind: "exited", exitCode: 0 },
        stdout: emptyOutput(), stderr: emptyOutput() } }, cleanupComplete: true } as const;
}

function qemuResult(assignment: NativeQemuHostAssignment) {
  const timestamp = "2026-10-12T00:00:00.000Z";
  const event = Reflect.get(assignment.claim, "event");
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new TypeError("QEMU claim event is missing");
  }
  const reviewId = Reflect.get(event, "reviewId");
  if (typeof reviewId !== "string") throw new TypeError("QEMU review ID is missing");
  return { schemaVersion: 1, eventId: randomUUID(), occurredAt: timestamp,
    eventType: "dim.ci.job.completed", payload: { executionKind: "qemu", evidenceClass: "candidate-controlled",
      reviewId, attemptId: assignment.attempt.attemptId,
      descriptor: assignment.attempt.descriptor, descriptorDigest: assignment.attempt.descriptorDigest,
      hostId: qemuClaimString(assignment, "hostId"), capacity: qemuClaimString(assignment, "capacity"),
      startedAt: timestamp, finishedAt: timestamp, result: "success",
      completion: { kind: "exited", exitCode: 0 }, stdout: emptyOutput(), stderr: emptyOutput() } } as const;
}

function qemuClaimString(assignment: NativeQemuHostAssignment, field: "claimId" | "hostId" | "capacity"): string {
  const value = Reflect.get(assignment.claim, field);
  if (typeof value !== "string") throw new TypeError(`QEMU ${field} is missing`);
  return value;
}

function emptyOutput() {
  return { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false } as const;
}

async function waitForResults(fixture: NativeAutomaticCiFixture, ordinaryCount: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (delivered(fixture.ordinaryDatabase, "native_root_ci_report_outbox") === ordinaryCount
      && delivered(fixture.qemuDatabase, "native_qemu_report_outbox") === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new TypeError("automatic CI result acknowledgements are missing");
}

function delivered(database: string, table: "native_root_ci_report_outbox" | "native_qemu_report_outbox"): number {
  const connection = new DatabaseSync(database, { readOnly: true });
  try { return Number(Reflect.get(connection.prepare(`SELECT count(*) count FROM ${table} WHERE state='delivered'`).get()
    ?? {}, "count")); }
  finally { connection.close(); }
}

async function waitForEventCounts(
  fixture: NativeAutomaticCiFixture,
  expected: { readonly ordinary: number; readonly qemu: number }
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const current = eventCounts(fixture);
    if (current.ordinary === expected.ordinary && current.qemu === expected.qemu) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new TypeError("automatic CI event counts did not converge");
}

function eventCounts(fixture: NativeAutomaticCiFixture): { readonly ordinary: number; readonly qemu: number } {
  return { ordinary: rows(fixture.ordinaryDatabase, "native_root_ci_event_receipts"),
    qemu: rows(fixture.qemuDatabase, "native_qemu_events") };
}

function rows(database: string, table: "native_root_ci_event_receipts" | "native_qemu_events"): number {
  const connection = new DatabaseSync(database, { readOnly: true });
  try { return Number(Reflect.get(connection.prepare(`SELECT count(*) count FROM ${table}`).get() ?? {}, "count")); }
  finally { connection.close(); }
}
