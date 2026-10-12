import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeQemuAuthorityClient, type NativeQemuAuthorityClient }
  from "../../../../core/packages/core/src/nativeQemuAuthorityClient.js";
import type { NativeQemuSchedulerConfig } from "../../../../core/packages/core/src/nativeQemuSchedulerConfig.js";
import { configuredNativeQemuSchedulerServer } from "../../../../core/packages/core/src/nativeQemuSchedulerService.js";
import { createNodeAdmissionVerifierHttpClient, type AdmissionVerifierHttpClient,
  type AdmissionVerifierHttpRequest, type AdmissionVerifierHttpResponse }
  from "../../../../core/packages/native-git/src/ordinary-admission-http.js";
import { authoritativePolicy } from "./authoritativeNativeCandidateFixture.js";
import { createBundleReview, nativeBundleReviewFixture } from "./nativeBundleReviewFixture.js";
import { cleanupFinalizeFixtures, closeFinalizeService, generationId, hostPromoterAuthorization,
  humanReviewerAuthorization, startFinalizeService }
  from "./nativeRootImportFinalizeFixture.js";

const servers: ReturnType<typeof configuredNativeQemuSchedulerServer>[] = [];
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await cleanupFinalizeFixtures();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const token = (character: string): string => Buffer.alloc(32, character).toString("base64url");
const auth = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

describe("authoritative native QEMU delivery", () => {
  it("retries stale and lost delivery, stores QEMU evidence, and promotes the approved review", async () => {
    // Given
    const root = await mkdtemp("/tmp/native-qemu-e2e-");
    temporaryRoots.push(root);
    const config = schedulerConfig(join(root, "qemu.sqlite3"), 10_000);
    let authority: NativeQemuAuthorityClient | undefined;
    const forwarding: NativeQemuAuthorityClient = {
      readPolicy(projectId, signal) { return requiredAuthority(authority).readPolicy(projectId, signal); },
      proveEvent(event, signal) { return requiredAuthority(authority).proveEvent(event, signal); },
      issue(claim, capacity, signal) { return requiredAuthority(authority).issue(claim, capacity, signal); },
      candidateLease(claim, attemptId, descriptorDigest, signal) {
        return requiredAuthority(authority).candidateLease(claim, attemptId, descriptorDigest, signal);
      },
      report(claim, event, signal) { return requiredAuthority(authority).report(claim, event, signal); },
      revoke(claim, attemptId, signal) { return requiredAuthority(authority).revoke(claim, attemptId, signal); }
    };
    const scheduler = configuredNativeQemuSchedulerServer(config, forwarding);
    servers.push(scheduler);
    await new Promise<void>((resolve) => scheduler.listen(0, "127.0.0.1", resolve));
    const schedulerOrigin = origin(scheduler.address());
    const transport = new LostQemuAcknowledgementClient(createNodeAdmissionVerifierHttpClient());
    const qemuCi = {
      endpoint: schedulerOrigin, serviceId: "qemu-main" as const, query: config.credentials.query,
      eventIntake: config.credentials.eventIntake, identity: config.nativeGit.identity,
      attemptIssuer: config.nativeGit.attemptIssuer, candidateReader: config.nativeGit.candidateReader,
      resultReporter: config.nativeGit.resultReporter
    };
    const fixture = await nativeBundleReviewFixture("qemu-delivery", undefined,
      authoritativePolicy(["owner"], [], [
        { name: "integration", kind: "qemu", evidenceClass: "candidate-controlled" }
      ]), undefined, transport, undefined, undefined, { qemuCi }, undefined, qemuOnlyRunner());
    authority = createNativeQemuAuthorityClient({ ...config,
      nativeGit: { ...config.nativeGit, endpoint: fixture.service.origin } });
    // When
    const envelope = await createBundleReview(fixture.service);
    const event = envelope.events.find(({ executionKind }) => executionKind === "qemu");
    if (event === undefined) throw new TypeError("QEMU event is missing");
    await transport.lostAcknowledgement;
    await closeFinalizeService(fixture.service);
    const restarted = await startFinalizeService(fixture.root, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, transport, undefined, undefined, { qemuCi });
    authority = createNativeQemuAuthorityClient({ ...config,
      nativeGit: { ...config.nativeGit, endpoint: restarted.origin } });
    await waitFor(() => eventCount(config.database) === 1 && transport.eventBodies.length === 3);
    expect((transport.eventTimes[1] ?? 0) - (transport.eventTimes[0] ?? 0)).toBeGreaterThanOrEqual(200);
    const claimResponses = await Promise.all(config.hosts.map((host) => fetch(`${schedulerOrigin}/v1/qemu-host-claims`, {
      method: "POST", headers: { authorization: auth(host.hostId, host.hostToken), "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, requestId: randomUUID(), capacity: "kvm-1" })
    })));
    const winner = claimResponses.find(({ status }) => status === 201);
    if (winner === undefined) throw new TypeError("QEMU claim is missing");
    const assignment = await winner.json() as Readonly<Record<string, unknown>>;
    const claim = record(assignment.claim);
    const attempt = record(assignment.attempt);
    const host = config.hosts.find(({ hostId }) => hostId === claim.hostId);
    if (host === undefined) throw new TypeError("QEMU host is missing");
    const occurredAt = new Date().toISOString();
    const terminalEvent = { schemaVersion: 1, eventId: randomUUID(), occurredAt,
      eventType: "dim.ci.job.completed", payload: { executionKind: "qemu", evidenceClass: "candidate-controlled",
        reviewId: event.reviewId, attemptId: attempt.attemptId, descriptorDigest: attempt.descriptorDigest,
        descriptor: attempt.descriptor, hostId: claim.hostId, capacity: claim.capacity,
        startedAt: occurredAt, finishedAt: occurredAt, result: "success",
        completion: { kind: "exited", exitCode: 0 },
        stdout: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false },
        stderr: { bytes: "0", sha256: `sha256:${"0".repeat(64)}`, truncated: false } } };
    await post(`${schedulerOrigin}/v1/qemu-host-results`, { schemaVersion: 1, requestId: randomUUID(),
      claimId: claim.claimId, capacity: claim.capacity, cleanupComplete: true, terminalEvent },
      auth(host.hostId, host.hostToken));

    // Then
    expect(claimResponses.map(({ status }) => status).sort()).toEqual([201, 204]);
    expect(transport.eventBodies[1]).toBe(transport.eventBodies[0]);
    expect(transport.eventBodies[2]).toBe(transport.eventBodies[0]);
    expect(eventCount(config.database)).toBe(1);
    const marker = JSON.parse(await readFile(join(fixture.root, "project-a", "root.git",
      "dim-authoritative-reviews", "qemu-delivered", `${event.eventId}.json`), "utf8"));
    expect(marker).toEqual(expect.objectContaining({ schemaVersion: 3, state: "recorded", eventId: event.eventId }));
    const statusUrl = `${schedulerOrigin}/v1/qemu-events/${event.eventId}/status`;
    const statusHeaders = { authorization: auth(config.credentials.query.username, config.credentials.query.password) };
    await waitFor(async () => record(await (await fetch(statusUrl, { headers: statusHeaders })).json()).state === "completed");
    const status = await fetch(statusUrl, { headers: statusHeaders });
    expect(await status.json()).toEqual(expect.objectContaining({ state: "completed", eventId: event.eventId,
      attemptId: attempt.attemptId, result: expect.objectContaining({ result: "success" }) }));
    const authorityState = JSON.parse(await readFile(join(fixture.root, "project-a", "root.git",
      "dim-authoritative-qemu", "state.json"), "utf8")) as Readonly<Record<string, unknown>>;
    expect(authorityState.statuses).toEqual([expect.objectContaining({ attemptId: attempt.attemptId, result: "success" })]);
    await post(`${restarted.origin}/v1/projects/project-a/repositories/root/reviews/${event.reviewId}/approvals`,
      { requestId: randomUUID() }, humanReviewerAuthorization);
    expect(await post(`${restarted.origin}/v1/projects/project-a/repositories/root/reviews/${event.reviewId}/promotions`,
      { schemaVersion: 1 }, hostPromoterAuthorization)).toMatchObject({ outcome: "promoted", sequence: 1 });
  }, 30_000);
});

class LostQemuAcknowledgementClient implements AdmissionVerifierHttpClient {
  readonly eventBodies: string[] = [];
  readonly eventTimes: number[] = [];
  private reject = true;
  private lose = true;
  private lostResolve: (() => void) | undefined;
  readonly lostAcknowledgement = new Promise<void>((resolve) => { this.lostResolve = resolve; });
  constructor(private readonly delegate: AdmissionVerifierHttpClient) {}
  async request(input: AdmissionVerifierHttpRequest): Promise<AdmissionVerifierHttpResponse> {
    if (input.path === "/v1/qemu-events") {
      this.eventBodies.push(input.body ?? "");
      this.eventTimes.push(Date.now());
      if (this.reject) {
        this.reject = false;
        return { statusCode: 409, contentType: "application/json", cacheControl: "no-store",
          body: Buffer.from(JSON.stringify({ error: "stale" })) };
      }
    }
    const response = await this.delegate.request(input);
    if (input.path === "/v1/qemu-events") {
      if (this.lose) { this.lose = false; this.lostResolve?.(); throw new LostAcknowledgementError(); }
    }
    return response;
  }
}
function schedulerConfig(database: string, eligibilityLeaseMilliseconds = 120_000): NativeQemuSchedulerConfig {
  const capacity = { capacity: "kvm-1", runnerBaseImage: `runner@sha256:${"1".repeat(64)}`,
    jobBaseImage: `job@sha256:${"2".repeat(64)}`, bounds: { cpu: "2", memoryBytes: "1024", pids: "64",
      wallClockSeconds: "60", outputBytes: "1024" } };
  return { schemaVersion: 2, serviceId: "qemu-main", host: "127.0.0.1", port: 1, database,
    eligibilityLeaseMilliseconds, claimLeaseMilliseconds: 60_000,
    nativeGit: { endpoint: "http://127.0.0.1:1", serviceId: "native-main",
      identity: { username: "qemu-identity", password: token("q") },
      attemptIssuer: { username: "qemu-attempts", password: token("r") },
      candidateReader: { username: "qemu-reader", password: token("y") },
      resultReporter: { username: "qemu-results", password: token("s") } },
    credentials: { eventIntake: { username: "qemu-events", password: token("t") },
      query: { username: "qemu-query", password: token("v") } },
    hosts: [{ hostId: "node-a", hostToken: token("w"), capacities: [capacity] },
      { hostId: "node-b", hostToken: token("x"), capacities: [capacity] }] };
}
function requiredAuthority(value: NativeQemuAuthorityClient | undefined): NativeQemuAuthorityClient {
  if (value === undefined) throw new TypeError("native QEMU authority is unavailable"); return value;
}
function origin(address: ReturnType<ReturnType<typeof configuredNativeQemuSchedulerServer>["address"]>): string {
  if (address === null || typeof address === "string") throw new TypeError("listener is unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function post(url: string, body: unknown, authorization: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: "POST", headers: { authorization, "content-type": "application/json",
    "x-dim-generation-id": generationId },
    body: JSON.stringify(body) });
  const responseBody = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(responseBody)).toBeLessThan(300);
  return responseBody;
}

function qemuOnlyRunner(): string {
  return `schemaVersion: 4
ordinary:
  jobs: {}
qemu:
  jobs:
    integration:
      script: .dim/ci/jobs/integration.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
`;
}
function eventCount(database: string): number {
  const connection = new DatabaseSync(database, { readOnly: true });
  try { return Number(record(connection.prepare("SELECT count(*) AS count FROM native_qemu_events").get()).count); }
  finally { connection.close(); }
}
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new TypeError("QEMU delivery condition was not reached");
}
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("record is invalid");
  return Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
}
class LostAcknowledgementError extends Error { readonly name = "LostAcknowledgementError"; }
