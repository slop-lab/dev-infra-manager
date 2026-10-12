import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeQemuAuthorityClient } from "../../../../core/packages/core/src/nativeQemuAuthorityClient.js";
import type { NativeQemuSchedulerConfig } from "../../../../core/packages/core/src/nativeQemuSchedulerConfig.js";
import { configuredNativeQemuSchedulerServer } from "../../../../core/packages/core/src/nativeQemuSchedulerService.js";
import { admitNativeQemuProject, queryNativeQemuEvent }
  from "../../../../core/packages/core/src/nativeQemuOperator.js";

const servers: ReturnType<typeof configuredNativeQemuSchedulerServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));
const token = (character: string): string => Buffer.alloc(32, character).toString("base64url");
const auth = (username: string, password: string): string => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const event = { schemaVersion: 2 as const, type: "dim.native.review-job.available" as const,
  eventId: "a".repeat(64), projectId: "project-a", repositoryId: "root" as const,
  protectedRef: "refs/heads/main", reviewId: "b".repeat(64), expectedProtectedHead: "c".repeat(40),
  candidateCommit: "d".repeat(40), candidateTree: "e".repeat(40), policyRevision: "f".repeat(64),
  requiredReviewRevision: "1".repeat(64), requiredJobSetRevision: "2".repeat(64),
  executionKind: "qemu" as const, jobName: "integration", evidenceClass: "candidate-controlled" as const };

describe("native QEMU scheduler service", () => {
  it("serves distinct two-node capacity without a double lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-qemu-http-"));
    const config = schedulerConfig(join(root, "qemu.sqlite3"));
    let issues = 0;
    let candidateLeases = 0;
    const authority: NativeQemuAuthorityClient = {
      async readPolicy(projectId) { return { projectId, policyRevision: event.policyRevision,
        requiredJobSetRevision: event.requiredJobSetRevision, requiredQemuJobs: [event.jobName] }; },
      async proveEvent() {},
      async issue(claim) { issues += 1; return { attemptId: randomUUID(), descriptorDigest: `sha256:${"3".repeat(64)}`,
        descriptor: { jobName: claim.event.jobName } }; },
      async candidateLease() { candidateLeases += 1;
        return { username: "candidate", password: token("j"), expiresAt: Date.now() + 30_000 }; },
      async report() {}, async revoke() {}
    };
    const server = configuredNativeQemuSchedulerServer(config, authority);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new TypeError("listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const configPath = join(root, "operator.json");
    await writeFile(configPath, `${JSON.stringify({ ...config, port: address.port })}\n`, { mode: 0o600 });
    const admitted = await admitNativeQemuProject("project-a", configPath) as Record<string, unknown>;
    const admissionGeneration = String(admitted.admissionGeneration);
    await post(`${origin}/v1/qemu-events`, { schemaVersion: 1, requestId: randomUUID(), admissionGeneration, event },
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
    await post(`${origin}/v1/qemu-host-results`, { schemaVersion: 1, requestId: randomUUID(), claimId,
      capacity: String(claim.capacity), cleanupComplete: true, terminalEvent },
      auth(String(claim.hostId), config.hosts.find(({ hostId }) => hostId === claim.hostId)?.hostToken ?? ""));
    expect(await queryNativeQemuEvent(event.eventId, configPath)).toEqual(expect.objectContaining({ eventId: event.eventId,
      state: "completed", claimId, result: expect.objectContaining({ result: "success" }) }));
    const database = new DatabaseSync(config.database, { readOnly: true });
    try {
      expect(database.prepare("SELECT count(*) AS count FROM native_qemu_events").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT count(*) AS count FROM native_qemu_claims").get()).toEqual({ count: 1 });
    } finally { database.close(); }
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
  return { schemaVersion: 1, serviceId: "qemu-main", host: "127.0.0.1", port: 0, database,
    admissionLeaseMilliseconds: 120_000, claimLeaseMilliseconds: 60_000,
    nativeGit: { endpoint: "http://127.0.0.1:9080", serviceId: "native-main",
      identity: { username: "identity", password: token("a") }, attemptIssuer: { username: "attempts", password: token("b") },
      candidateReader: { username: "candidate-reader", password: token("i") },
      resultReporter: { username: "results", password: token("c") } },
    credentials: { eventIntake: { username: "events", password: token("d") },
      registrar: { username: "registrar", password: token("e") }, query: { username: "query", password: token("f") } },
    hosts: [{ hostId: "node-a", hostToken: token("g"), capacities: [capacity] },
      { hostId: "node-b", hostToken: token("h"), capacities: [capacity] }] };
}
