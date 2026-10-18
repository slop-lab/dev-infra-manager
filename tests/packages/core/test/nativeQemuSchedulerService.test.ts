import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  NativeQemuAuthorityRejectedError,
  type NativeQemuAuthorityClient
} from "../../../../core/packages/managed/src/nativeQemuAuthorityClient.js";
import type { NativeQemuSchedulerConfig } from "../../../../core/packages/managed/src/nativeQemuSchedulerConfig.js";
import { configuredNativeQemuSchedulerServer } from "../../../../core/packages/managed/src/nativeQemuSchedulerService.js";
import { queryNativeQemuEvent }
  from "../../../../core/packages/managed/src/nativeQemuOperator.js";

const servers: ReturnType<typeof configuredNativeQemuSchedulerServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));
const token = (character: string): string => Buffer.alloc(32, character).toString("base64url");
const auth = (username: string, password: string): string => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const envelopeId = "9".repeat(64);
const event = { schemaVersion: 3 as const, type: "dim.native.review-job.available" as const,
  eventId: createHash("sha256").update("dim-native-authoritative-review-event-v3\0")
    .update(JSON.stringify({ envelopeId, executionKind: "qemu", jobName: "integration" })).digest("hex"),
  envelopeId, projectId: "project-a", repositoryId: "root" as const,
  protectedRef: "refs/heads/main", reviewId: "b".repeat(64), expectedProtectedHead: "c".repeat(40),
  candidateCommit: "d".repeat(40), candidateTree: "e".repeat(40), policyRevision: "f".repeat(64),
  requiredReviewRevision: "1".repeat(64), qualityRevision: "2".repeat(64),
  executionKind: "qemu" as const, jobName: "integration", evidenceClass: "candidate-controlled" as const };

describe("native QEMU scheduler service", () => {
  it("serves distinct two-node capacity without a double lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-qemu-http-"));
    const baseConfig = schedulerConfig(join(root, "qemu.sqlite3"));
    const currentCapacities = baseConfig.hosts.map((host) => [...host.capacities]);
    const config: NativeQemuSchedulerConfig = { ...baseConfig,
      hosts: baseConfig.hosts.map((host, index) => ({ ...host, capacities: currentCapacities[index] ?? [] })) };
    let issues = 0;
    let candidateLeases = 0;
    let reportCompleted: (() => void) | undefined;
    const reported = new Promise<void>((resolve) => { reportCompleted = resolve; });
    const authority: NativeQemuAuthorityClient = {
      async readPolicy(projectId) { return { projectId, policyRevision: event.policyRevision,
        requiredJobSetRevision: event.qualityRevision, requiredQemuJobs: [event.jobName] }; },
      async proveEvent() {},
      async issue(claim) { issues += 1; return { attemptId: randomUUID(), descriptorDigest: `sha256:${"3".repeat(64)}`,
        descriptor: { jobName: claim.event.jobName } }; },
      async candidateLease() { candidateLeases += 1;
        return { username: "candidate", password: token("j"), expiresAt: Date.now() + 30_000 }; },
      async report() { reportCompleted?.(); }, async revoke() {}
    };
    const server = configuredNativeQemuSchedulerServer(config, authority);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new TypeError("listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const configPath = join(root, "operator.json");
    await writeFile(configPath, `${JSON.stringify({ ...config, port: address.port })}\n`, { mode: 0o600 });
    await post(`${origin}/v1/qemu-events`, { schemaVersion: 1, requestId: randomUUID(), event },
      auth(config.credentials.eventIntake.username, config.credentials.eventIntake.password));

    const requestIds = config.hosts.map(() => randomUUID());
    const responses = await Promise.all(config.hosts.map((host, index) => fetch(`${origin}/v1/qemu-host-claims`, {
      method: "POST", headers: { authorization: auth(host.hostId, host.hostToken), "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, requestId: requestIds[index], capacity: "kvm-1" })
    })));
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 204]);
    const winning = responses.find(({ status }) => status === 201);
    if (winning === undefined) throw new TypeError("winning claim is missing");
    const assignment = await winning.json() as Readonly<Record<string, unknown>>;
    const winnerIndex = responses.indexOf(winning);
    const claim = assignment.claim as Readonly<Record<string, unknown>>;
    const attempt = assignment.attempt as Readonly<Record<string, unknown>>;
    const candidateRequest = { schemaVersion: 1, requestId: randomUUID(), claimId: claim.claimId,
      attemptId: attempt.attemptId, descriptorDigest: attempt.descriptorDigest };
    const candidateLease = await post(`${origin}/v1/qemu-host-candidate-leases`, candidateRequest,
      auth(config.hosts[winnerIndex]?.hostId ?? "", config.hosts[winnerIndex]?.hostToken ?? ""));
    const foreignLease = await fetch(`${origin}/v1/qemu-host-candidate-leases`, { method: "POST", headers: {
      authorization: auth(config.hosts[(winnerIndex + 1) % 2]?.hostId ?? "",
        config.hosts[(winnerIndex + 1) % 2]?.hostToken ?? ""), "content-type": "application/json" },
      body: JSON.stringify({ ...candidateRequest, requestId: randomUUID() }) });
    const replay = await fetch(`${origin}/v1/qemu-host-claims`, { method: "POST", headers: {
      authorization: auth(config.hosts[winnerIndex]?.hostId ?? "", config.hosts[winnerIndex]?.hostToken ?? ""),
      "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1,
      requestId: requestIds[winnerIndex], capacity: "kvm-1" }) });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(assignment);
    expect(issues).toBe(1);
    expect(candidateLease.username).toBe("candidate");
    expect(foreignLease.status).toBe(404);
    expect(candidateLeases).toBe(1);
    const claimId = String(claim.claimId);
    const timestamp = new Date().toISOString();
    const terminalEvent = { schemaVersion: 1, eventId: randomUUID(), occurredAt: timestamp,
      eventType: "dim.ci.job.completed", payload: { executionKind: "qemu",
      evidenceClass: "candidate-controlled", reviewId: event.reviewId, attemptId: attempt.attemptId,
      descriptorDigest: attempt.descriptorDigest, descriptor: attempt.descriptor, hostId: claim.hostId,
      capacity: claim.capacity, startedAt: timestamp, finishedAt: timestamp, result: "success",
      completion: { kind: "exited", exitCode: 0 }, stdout: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`,
        truncated: false }, stderr: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false } } };
    const removedCapacity = currentCapacities[winnerIndex]?.shift();
    if (removedCapacity === undefined) throw new TypeError("winning capacity is missing");
    const removedResult = await fetch(`${origin}/v1/qemu-host-results`, { method: "POST", headers: {
      authorization: auth(String(claim.hostId), config.hosts[winnerIndex]?.hostToken ?? ""),
      "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), claimId,
      capacity: String(claim.capacity), cleanupComplete: true, terminalEvent }) });
    currentCapacities[winnerIndex]?.push(removedCapacity);
    expect(removedResult.status).toBe(404);
    await post(`${origin}/v1/qemu-host-results`, { schemaVersion: 1, requestId: randomUUID(), claimId,
      capacity: String(claim.capacity), cleanupComplete: true, terminalEvent },
      auth(String(claim.hostId), config.hosts.find(({ hostId }) => hostId === claim.hostId)?.hostToken ?? ""));
    await reported;
    expect(await queryNativeQemuEvent(event.eventId, configPath)).toEqual(expect.objectContaining({ eventId: event.eventId,
      state: "completed", claimId, result: expect.objectContaining({ result: "success" }) }));
    const database = new DatabaseSync(config.database, { readOnly: true });
    try {
      expect(database.prepare("SELECT count(*) AS count FROM native_qemu_events").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT count(*) AS count FROM native_qemu_claims").get()).toEqual({ count: 1 });
    } finally { database.close(); }
  });

  it("supersedes a definitively stale queue head and serves the next event", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "native-qemu-stale-head-"));
    const config = schedulerConfig(join(root, "qemu.sqlite3"));
    const nextEvent = eventForEnvelope("8".repeat(64));
    const authority: NativeQemuAuthorityClient = {
      async readPolicy(projectId) { return { projectId, policyRevision: event.policyRevision,
        requiredJobSetRevision: event.qualityRevision, requiredQemuJobs: [event.jobName] }; },
      async proveEvent() {},
      async issue(claim) {
        if (claim.event.eventId === event.eventId) throw new NativeQemuAuthorityRejectedError(404);
        return { attemptId: randomUUID(), descriptorDigest: `sha256:${"3".repeat(64)}`,
          descriptor: { jobName: claim.event.jobName } };
      },
      async candidateLease() { throw new TypeError("not used"); },
      async report() {},
      async revoke() {}
    };
    const server = configuredNativeQemuSchedulerServer(config, authority);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new TypeError("listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const intakeAuth = auth(config.credentials.eventIntake.username, config.credentials.eventIntake.password);
    await post(`${origin}/v1/qemu-events`, { schemaVersion: 1, requestId: randomUUID(), event }, intakeAuth);
    await post(`${origin}/v1/qemu-events`, { schemaVersion: 1, requestId: randomUUID(), event: nextEvent }, intakeAuth);

    // When
    const response = await fetch(`${origin}/v1/qemu-host-claims`, { method: "POST", headers: {
      authorization: auth(config.hosts[0]?.hostId ?? "", config.hosts[0]?.hostToken ?? ""),
      "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: 1,
      requestId: randomUUID(), capacity: "kvm-1" }) });

    // Then
    expect(response.status).toBe(201);
    const assignment = await response.json() as { readonly claim: { readonly event: { readonly eventId: string } } };
    expect(assignment.claim.event.eventId).toBe(nextEvent.eventId);
    const database = new DatabaseSync(config.database, { readOnly: true });
    try {
      expect(database.prepare("SELECT state FROM native_qemu_events WHERE event_id=?").get(event.eventId))
        .toEqual({ state: "superseded" });
      expect(database.prepare("SELECT state FROM native_qemu_events WHERE event_id=?").get(nextEvent.eventId))
        .toEqual({ state: "active" });
    } finally { database.close(); }
  });

  it("retries the exact reservation after transient authority failure", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "native-qemu-transient-"));
    const config = schedulerConfig(join(root, "qemu.sqlite3"));
    let issueCalls = 0;
    const authority: NativeQemuAuthorityClient = {
      async readPolicy(projectId) { return { projectId, policyRevision: event.policyRevision,
        requiredJobSetRevision: event.qualityRevision, requiredQemuJobs: [event.jobName] }; },
      async proveEvent() {},
      async issue(claim) {
        issueCalls += 1;
        if (issueCalls === 1) throw new Error("temporary authority outage");
        return { attemptId: randomUUID(), descriptorDigest: `sha256:${"3".repeat(64)}`,
          descriptor: { jobName: claim.event.jobName } };
      },
      async candidateLease() { throw new TypeError("not used"); },
      async report() {},
      async revoke() {}
    };
    const server = configuredNativeQemuSchedulerServer(config, authority);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new TypeError("listener");
    const origin = `http://127.0.0.1:${address.port}`;
    await post(`${origin}/v1/qemu-events`, { schemaVersion: 1, requestId: randomUUID(), event },
      auth(config.credentials.eventIntake.username, config.credentials.eventIntake.password));
    const requestId = randomUUID();
    const headers = { authorization: auth(config.hosts[0]?.hostId ?? "", config.hosts[0]?.hostToken ?? ""),
      "content-type": "application/json" };
    const body = JSON.stringify({ schemaVersion: 1, requestId, capacity: "kvm-1" });

    // When
    const unavailable = await fetch(`${origin}/v1/qemu-host-claims`, { method: "POST", headers, body });
    const retried = await fetch(`${origin}/v1/qemu-host-claims`, { method: "POST", headers, body });

    // Then
    expect(unavailable.status).toBe(503);
    expect(retried.status).toBe(201);
    expect(issueCalls).toBe(2);
  });
});

async function post(url: string, body: unknown, authorization: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body) });
  expect(response.status).toBeLessThan(300);
  return response.status === 204 ? {} : await response.json() as Record<string, unknown>;
}
function schedulerConfig(database: string): NativeQemuSchedulerConfig {
  const capacity = { capacity: "kvm-1", runnerBaseImage: `runner@sha256:${"1".repeat(64)}`,
    jobBaseImage: `job@sha256:${"2".repeat(64)}`, bounds: { cpu: "2", memoryBytes: "1024", pids: "64",
      wallClockSeconds: "60", outputBytes: "1024" } };
  return { schemaVersion: 2, serviceId: "qemu-main", host: "127.0.0.1", port: 0, database,
    eligibilityLeaseMilliseconds: 120_000, claimLeaseMilliseconds: 60_000,
    nativeGit: { endpoint: "http://127.0.0.1:9080", serviceId: "native-main",
      identity: { username: "identity", password: token("a") }, attemptIssuer: { username: "attempts", password: token("b") },
      candidateReader: { username: "candidate-reader", password: token("i") },
      resultReporter: { username: "results", password: token("c") } },
    credentials: { eventIntake: { username: "events", password: token("d") },
      query: { username: "query", password: token("f") } },
    hosts: [{ hostId: "node-a", hostToken: token("g"), capacities: [capacity] },
      { hostId: "node-b", hostToken: token("h"), capacities: [capacity] }] };
}

function eventForEnvelope(nextEnvelopeId: string): typeof event {
  return { ...event, envelopeId: nextEnvelopeId, eventId: createHash("sha256")
    .update("dim-native-authoritative-review-event-v3\0")
    .update(JSON.stringify({ envelopeId: nextEnvelopeId, executionKind: "qemu", jobName: event.jobName })).digest("hex") };
}
