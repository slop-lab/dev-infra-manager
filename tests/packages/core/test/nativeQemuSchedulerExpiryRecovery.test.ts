import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeQemuAuthorityClient } from "../../../../core/packages/core/src/nativeQemuAuthorityClient.js";
import type { NativeQemuSchedulerConfig } from "../../../../core/packages/core/src/nativeQemuSchedulerConfig.js";
import { claimNativeQemuHostAssignment,
  replayNativeQemuHostJournal } from "../../../../core/packages/core/src/nativeQemuHostService.js";
import { NativeQemuHostJournal } from "../../../../core/packages/core/src/nativeQemuHostJournal.js";
import { configuredNativeQemuSchedulerServer } from "../../../../core/packages/core/src/nativeQemuSchedulerService.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { qemuDescriptor } from "./nativeQemuHostFixture.js";
import { nativeQemuDescriptorDigest } from "../../../../core/packages/core/src/nativeQemuAssignment.js";

const servers: ReturnType<typeof configuredNativeQemuSchedulerServer>[] = [];
const token = (character: string): string => Buffer.alloc(32, character).toString("base64url");
const authorization = (hostId: string, password: string): string =>
  `Basic ${Buffer.from(`${hostId}:${password}`).toString("base64")}`;
const baseEvent = { schemaVersion: 3 as const, type: "dim.native.review-job.available" as const,
  eventId: createHash("sha256").update("dim-native-authoritative-review-event-v3\0")
    .update(JSON.stringify({ envelopeId: "9".repeat(64), executionKind: "qemu", jobName: "integration" }))
    .digest("hex"), projectId: "project-a", repositoryId: "root" as const,
  protectedRef: "refs/heads/main", reviewId: "b".repeat(64), envelopeId: "9".repeat(64), expectedProtectedHead: "c".repeat(40),
  candidateCommit: "d".repeat(40), candidateTree: "e".repeat(40), policyRevision: "f".repeat(64),
  requiredReviewRevision: "1".repeat(64), qualityRevision: "2".repeat(64),
  executionKind: "qemu" as const, jobName: "integration", evidenceClass: "candidate-controlled" as const };
const secondEnvelopeId = "8".repeat(64);
const secondEvent = { ...baseEvent, envelopeId: secondEnvelopeId,
  eventId: createHash("sha256").update("dim-native-authoritative-review-event-v3\0")
    .update(JSON.stringify({ envelopeId: secondEnvelopeId, executionKind: "qemu", jobName: "integration" }))
    .digest("hex") };

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("native QEMU scheduler expiry recovery", () => {
  it("replays a response-lost expired assignment into owned cleanup without another execution", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fixture = await schedulerFixture();
    await fixture.enqueue(baseEvent);
    await fixture.enqueue(secondEvent);
    const stateDirectory = await mkdtemp(join(tmpdir(), "native-qemu-expired-host-"));
    const journal = new NativeQemuHostJournal(join(stateDirectory, "journal.json"));
    const requestId = randomUUID();
    await journal.save({ kind: "claim", requestId });
    const lost = await fixture.rawClaim("node-a", requestId);
    expect(lost.status).toBe(201);
    const firstAssignment = await lost.json() as Readonly<Record<string, unknown>>;
    const firstClaim = firstAssignment.claim as Readonly<Record<string, unknown>>;
    await fixture.restart();
    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));

    const foreignRecovery = await fixture.recover("node-b", String(firstClaim.claimId));
    const foreignCapacityRecovery = await fixture.recover("node-a", String(firstClaim.claimId), "kvm-2");
    const replayed = await claimNativeQemuHostAssignment(fixture.client("node-a"),
      new NativeQemuHostJournal(join(stateDirectory, "journal.json")), AbortSignal.timeout(1_000));

    expect(foreignRecovery.status).toBe(404);
    expect(foreignCapacityRecovery.status).toBe(404);
    expect(replayed).toBeUndefined();
    expect((await journal.load())?.kind).toBe("active");
    await replayNativeQemuHostJournal(fixture.client("node-a"), new CleanupRunner(), stateDirectory, journal);
    expect(await journal.load()).toBeUndefined();
    const next = await fixture.rawClaim("node-a", randomUUID());
    expect(next.status).toBe(201);
    const firstEventId = String((firstClaim.event as Readonly<Record<string, unknown>>).eventId);
    expect(((await next.json() as Record<string, unknown>).claim as Record<string, unknown>).event)
      .toEqual(expect.objectContaining({ eventId: firstEventId === baseEvent.eventId ? secondEvent.eventId : baseEvent.eventId }));
    expect(fixture.issues).toBe(2);
    expect(fixture.revocations).toEqual([firstClaim.claimId]);
  });

  it("accepts the exact durable result after lease expiry and acknowledgement loss", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fixture = await schedulerFixture({ failFirstReport: true });
    await fixture.enqueue(baseEvent);
    const response = await fixture.rawClaim("node-a", randomUUID());
    const assignment = await response.json() as Readonly<Record<string, unknown>>;
    const claim = assignment.claim as Readonly<Record<string, unknown>>;
    const attempt = assignment.attempt as Readonly<Record<string, unknown>>;
    const terminalEvent = terminal(attempt, claim);
    const stateDirectory = await mkdtemp(join(tmpdir(), "native-qemu-result-host-"));
    const journal = new NativeQemuHostJournal(join(stateDirectory, "journal.json"));
    await journal.save({ kind: "result", claimId: String(claim.claimId), terminalEvent });
    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));

    const malformed = await fixture.result("node-a", String(claim.claimId), { ...terminalEvent, extra: true });
    expect(malformed.status).toBe(400);
    const first = await fixture.result("node-a", String(claim.claimId), terminalEvent);
    expect(first.status).toBe(202);
    await fixture.restart();
    const foreign = await fixture.result("node-b", String(claim.claimId), terminalEvent);
    const foreignCapacity = await fixture.result("node-a", String(claim.claimId), terminalEvent, "kvm-2");
    await replayNativeQemuHostJournal(fixture.client("node-a"), new CleanupRunner(), stateDirectory,
      new NativeQemuHostJournal(join(stateDirectory, "journal.json")));

    expect(foreign.status).toBe(404);
    expect(foreignCapacity.status).toBe(404);
    expect(await journal.load()).toBeUndefined();
    expect(fixture.reports).toHaveLength(2);
    expect(fixture.reports[1]).toBe(fixture.reports[0]);
    expect(JSON.parse(fixture.reports[0] ?? "null")).toEqual(terminalEvent);
    expect(fixture.issues).toBe(1);
  });

  it("requeues demand when an unactivated reservation expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fixture = await schedulerFixture({ failFirstIssue: true });
    await fixture.enqueue(baseEvent);
    const failed = await fixture.rawClaim("node-a", randomUUID());
    expect(failed.status).toBe(503);
    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));

    const retried = await fixture.rawClaim("node-a", randomUUID());

    expect(retried.status).toBe(201);
    expect((((await retried.json()) as Record<string, unknown>).claim as Record<string, unknown>).event)
      .toEqual(expect.objectContaining({ eventId: baseEvent.eventId }));
    expect(fixture.issues).toBe(2);
  });
});

async function schedulerFixture(options: { readonly failFirstIssue?: boolean; readonly failFirstReport?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "native-qemu-expiry-http-"));
  const config = schedulerConfig(join(root, "qemu.sqlite3"));
  let origin = "";
  let issues = 0;
  const reports: string[] = [];
  const revocations: unknown[] = [];
  const authority: NativeQemuAuthorityClient = {
    async readPolicy(projectId) { return { projectId, policyRevision: baseEvent.policyRevision,
      requiredJobSetRevision: baseEvent.qualityRevision, requiredQemuJobs: [baseEvent.jobName] }; },
    async proveEvent() {},
    async issue(claim) {
      issues += 1;
      if (options.failFirstIssue === true && issues === 1) throw new IssueResponseLostError();
      const descriptor = { ...qemuDescriptor, admissionGeneration: claim.admissionGeneration,
          projectId: claim.event.projectId, repositoryId: claim.event.repositoryId,
          protectedRef: claim.event.protectedRef, expectedProtectedHead: claim.event.expectedProtectedHead,
          candidateCommit: claim.event.candidateCommit, candidateTree: claim.event.candidateTree,
          policyRevision: claim.event.policyRevision, requiredReviewRevision: claim.event.requiredReviewRevision,
    requiredJobSetRevision: claim.event.qualityRevision, jobName: claim.event.jobName,
          runnerBaseImage: `runner@sha256:${"1".repeat(64)}`, jobImage: `job@sha256:${"2".repeat(64)}`,
          bounds: { cpu: "2", memoryBytes: "1024", pids: "64", wallClockSeconds: "60", outputBytes: "1024" } };
      return { attemptId: randomUUID(), descriptorDigest: nativeQemuDescriptorDigest(descriptor), descriptor };
    },
    async candidateLease() { throw new TypeError("unused"); },
    async report(_claim, event) {
      reports.push(JSON.stringify(event));
      if (options.failFirstReport === true && reports.length === 1) throw new ResultAcknowledgementLostError();
    },
    async revoke(claim) { revocations.push(claim.claimId); }
  };
  const start = async (): Promise<void> => {
    const server = configuredNativeQemuSchedulerServer(config, authority);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const request = (username: string, path: string, body: unknown): Promise<Response> => fetch(`${origin}${path}`, {
    method: "POST", headers: { authorization: authorization(username, credentialPassword(config, username)),
      "content-type": "application/json" },
    body: JSON.stringify(body) });
  await start();
  return {
    get issues() { return issues; }, reports, revocations,
    async restart() {
      const server = servers.pop();
      if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
      await start();
    },
    async enqueue(event: typeof baseEvent) {
      return request(config.credentials.eventIntake.username, "/v1/qemu-events",
        { schemaVersion: 1, requestId: randomUUID(), event });
    },
    rawClaim: (hostId: string, requestId: string) => request(hostId, "/v1/qemu-host-claims",
      { schemaVersion: 1, requestId, capacity: "kvm-1" }),
    recover: (hostId: string, claimId: string, capacity = "kvm-1") => request(hostId, "/v1/qemu-host-recoveries",
      { schemaVersion: 1, requestId: randomUUID(), claimId, capacity, cleanupComplete: true }),
    result: (hostId: string, claimId: string, terminalEvent: Readonly<Record<string, unknown>>, capacity = "kvm-1") =>
      request(hostId, "/v1/qemu-host-results", { schemaVersion: 1, requestId: randomUUID(), claimId,
        capacity, cleanupComplete: true, terminalEvent }),
    client(hostId: string) { return {
      async claim(requestId: string) {
        const result = await request(hostId, "/v1/qemu-host-claims", { schemaVersion: 1, requestId, capacity: "kvm-1" });
        if (result.status === 204) return undefined;
        const body = await result.json() as Readonly<Record<string, unknown>>;
        return { claim: body.claim as Readonly<Record<string, unknown>>,
          attempt: body.attempt as import("../../../../core/packages/core/src/nativeQemuHostClient.js").NativeQemuHostAssignment["attempt"] };
      },
      async renew() {},
      async report(claimId: string, terminalEvent: Readonly<Record<string, unknown>>) {
        const result = await request(hostId, "/v1/qemu-host-results", { schemaVersion: 1, requestId: randomUUID(),
          claimId, capacity: "kvm-1", cleanupComplete: true, terminalEvent });
        if (!result.ok) throw new HostRequestError(result.status);
      },
      async recover(claimId: string) {
        const result = await request(hostId, "/v1/qemu-host-recoveries", { schemaVersion: 1, requestId: randomUUID(),
          claimId, capacity: "kvm-1", cleanupComplete: true });
        if (!result.ok) throw new HostRequestError(result.status);
      }
    }; }
  };
}

function terminal(attempt: Readonly<Record<string, unknown>>, claim: Readonly<Record<string, unknown>>) {
  const timestamp = "2026-01-01T00:00:01.000Z";
  return { schemaVersion: 1, eventId: randomUUID(), occurredAt: timestamp, eventType: "dim.ci.job.completed",
    payload: { executionKind: "qemu", evidenceClass: "candidate-controlled", reviewId: baseEvent.reviewId,
      attemptId: attempt.attemptId, descriptorDigest: attempt.descriptorDigest, descriptor: attempt.descriptor,
      hostId: claim.hostId, capacity: claim.capacity, startedAt: timestamp, finishedAt: timestamp, result: "success",
      completion: { kind: "exited", exitCode: 0 }, stdout: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`,
        truncated: false }, stderr: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false } } };
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
    hosts: [{ hostId: "node-a", hostToken: token("g"), capacities: [capacity, { ...capacity, capacity: "kvm-2" }] },
      { hostId: "node-b", hostToken: token("h"), capacities: [capacity] }] };
}

function credentialPassword(config: NativeQemuSchedulerConfig, username: string): string {
  const host = config.hosts.find((candidate) => candidate.hostId === username);
  if (host !== undefined) return host.hostToken;
  const credential = Object.values(config.credentials).find((candidate) => candidate.username === username);
  return credential?.password ?? "";
}

class CleanupRunner implements StreamingCommandRunner {
  run(command: string, args: string[]): Promise<CommandResult> {
    return Promise.resolve({ command, args, stdout: "", stderr: "", exitCode: 0 });
  }
  runStreaming(_command: string, _args: string[], _options?: RunOptions): Promise<number> { return Promise.resolve(0); }
}
class IssueResponseLostError extends Error { readonly name = "IssueResponseLostError"; }
class ResultAcknowledgementLostError extends Error { readonly name = "ResultAcknowledgementLostError"; }
class HostRequestError extends Error {
  readonly name = "HostRequestError";
  constructor(readonly status: number) { super(`host request failed with ${status}`); }
}
