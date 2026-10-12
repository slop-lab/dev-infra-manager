import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { NativeQemuSchedulerStore } from "../../../../core/packages/core/src/nativeQemuSchedulerStore.js";
import { qemuTerminalEvent } from "./nativeQemuHostFixture.js";

const stores: NativeQemuSchedulerStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

const event = {
  schemaVersion: 2 as const,
  type: "dim.native.review-job.available" as const,
  eventId: "a".repeat(64), projectId: "project-a", repositoryId: "root" as const,
  protectedRef: "refs/heads/main", reviewId: "b".repeat(64), expectedProtectedHead: "c".repeat(40),
  candidateCommit: "d".repeat(40), candidateTree: "e".repeat(40), policyRevision: "f".repeat(64),
  requiredReviewRevision: "1".repeat(64), requiredJobSetRevision: "2".repeat(64),
  executionKind: "qemu" as const, jobName: "integration", evidenceClass: "candidate-controlled" as const
};

describe("native QEMU scheduler store", () => {
  it("rejects an incompatible existing database without changing its bytes", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "native-qemu-store-"));
    const path = join(root, "state.sqlite3");
    const foreign = new DatabaseSync(path);
    foreign.exec("CREATE TABLE foreign_state (value TEXT NOT NULL); INSERT INTO foreign_state VALUES ('untouched')");
    foreign.close();
    await chmod(path, 0o600);
    const before = await readFile(path);

    // When
    const opening = (): NativeQemuSchedulerStore => new NativeQemuSchedulerStore(path);

    // Then
    expect(opening).toThrow(/state|database/i);
    expect(await readFile(path)).toEqual(before);
  });

  it("rejects a malformed persisted event without changing the database", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "native-qemu-store-"));
    const path = join(root, "state.sqlite3");
    const store = new NativeQemuSchedulerStore(path, () => 1_000);
    store.admit({ projectId: "project-a", admissionGeneration: "admission-1", leaseExpiresAt: 100_000,
      policyRevision: event.policyRevision, requiredJobSetRevision: event.requiredJobSetRevision,
      requiredQemuJobs: ["integration"] });
    store.enqueue("admission-1", event);
    store.close();
    const corruptor = new DatabaseSync(path);
    corruptor.prepare("UPDATE native_qemu_events SET event_json='{}'").run();
    corruptor.close();
    await chmod(path, 0o600);
    const before = await readFile(path);

    // When
    const opening = (): NativeQemuSchedulerStore => new NativeQemuSchedulerStore(path);

    // Then
    expect(opening).toThrow(/event|database/i);
    expect(await readFile(path)).toEqual(before);
  });

  it("leases one queued event to only one distinct node capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-qemu-store-"));
    let now = 1_000;
    const store = new NativeQemuSchedulerStore(join(root, "state.sqlite3"), () => now);
    stores.push(store);
    store.admit({ projectId: "project-a", admissionGeneration: "admission-1", leaseExpiresAt: 100_000,
      policyRevision: event.policyRevision, requiredJobSetRevision: event.requiredJobSetRevision,
      requiredQemuJobs: ["integration"] });
    expect(store.enqueue("admission-1", event)).toBe("created");

    const first = store.reserve({ requestId: "11111111-1111-4111-8111-111111111111",
      hostId: "node-a", capacity: "kvm-1", leaseMilliseconds: 60_000 });
    const nextEvent = { ...event, eventId: "9".repeat(64) };
    store.enqueue("admission-1", nextEvent);
    const second = store.reserve({ requestId: "22222222-2222-4222-8222-222222222222",
      hostId: "node-a", capacity: "kvm-1", leaseMilliseconds: 60_000 });

    expect(first?.event.eventId).toBe(event.eventId);
    expect(second).toBeUndefined();
    now += 60_001;
    expect(store.reserve({ requestId: "33333333-3333-4333-8333-333333333333",
      hostId: "node-a", capacity: "kvm-1", leaseMilliseconds: 60_000 })?.event.eventId).toBe(nextEvent.eventId);
  });

  it("requires cleanup before accepting one immutable terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-qemu-result-"));
    const store = new NativeQemuSchedulerStore(join(root, "state.sqlite3"), () => 1_000);
    stores.push(store);
    store.admit({ projectId: "project-a", admissionGeneration: "admission-1", leaseExpiresAt: 100_000,
      policyRevision: event.policyRevision, requiredJobSetRevision: event.requiredJobSetRevision,
      requiredQemuJobs: ["integration"] });
    store.enqueue("admission-1", event);
    const claim = store.reserve({ requestId: "11111111-1111-4111-8111-111111111111",
      hostId: "node-a", capacity: "kvm-1", leaseMilliseconds: 60_000 });
    if (claim === undefined) throw new TypeError("claim fixture");
    store.activate(claim.claimId, { attemptId: "22222222-2222-4222-8222-222222222222",
      descriptorDigest: `sha256:${"3".repeat(64)}`, descriptor: {} });
    expect(() => store.complete({ claimId: claim.claimId, cleanupComplete: false,
      eventId: qemuTerminalEvent.eventId, result: "success", terminalEvent: qemuTerminalEvent })).toThrow(/cleanup/i);
    expect(store.complete({ claimId: claim.claimId, cleanupComplete: true,
      eventId: qemuTerminalEvent.eventId, result: "success", terminalEvent: qemuTerminalEvent })).toBe("created");
    expect(store.complete({ claimId: claim.claimId, cleanupComplete: true,
      eventId: qemuTerminalEvent.eventId, result: "success", terminalEvent: qemuTerminalEvent })).toBe("replay");
  });

  it("keeps expired active capacity fenced until the same host records recovery", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "native-qemu-recovery-"));
    let now = 1_000;
    const store = new NativeQemuSchedulerStore(join(root, "state.sqlite3"), () => now);
    stores.push(store);
    store.admit({ projectId: "project-a", admissionGeneration: "admission-1", leaseExpiresAt: 100_000,
      policyRevision: event.policyRevision, requiredJobSetRevision: event.requiredJobSetRevision,
      requiredQemuJobs: ["integration"] });
    store.enqueue("admission-1", event);
    store.enqueue("admission-1", { ...event, eventId: "9".repeat(64) });
    const claim = store.reserve({ requestId: "11111111-1111-4111-8111-111111111111",
      hostId: "node-a", capacity: "kvm-1", leaseMilliseconds: 60_000 });
    if (claim === undefined) throw new TypeError("claim fixture");
    store.activate(claim.claimId, { attemptId: "22222222-2222-4222-8222-222222222222",
      descriptorDigest: `sha256:${"3".repeat(64)}`, descriptor: {} });

    // When
    now += 60_001;
    const expired = store.current(claim.claimId);
    const expiredReplay = store.assignment(claim.requestId, claim.hostId, claim.capacity);
    const fenced = store.reserve({ requestId: "33333333-3333-4333-8333-333333333333",
      hostId: "node-a", capacity: "kvm-1", leaseMilliseconds: 60_000 });
    store.recover(claim.claimId, "node-a", "kvm-1");
    const released = store.reserve({ requestId: "44444444-4444-4444-8444-444444444444",
      hostId: "node-a", capacity: "kvm-1", leaseMilliseconds: 60_000 });

    // Then
    expect(expired).toBeUndefined();
    expect(expiredReplay).toEqual({ claim, attempt: { attemptId: "22222222-2222-4222-8222-222222222222",
      descriptorDigest: `sha256:${"3".repeat(64)}`, descriptor: {} } });
    expect(fenced).toBeUndefined();
    expect(released?.event.eventId).not.toBe(claim.event.eventId);
  });

  it("replays the exact activated assignment after restart without issuing another claim", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "native-qemu-replay-"));
    const path = join(root, "state.sqlite3");
    const requestId = "11111111-1111-4111-8111-111111111111";
    const attempt = { attemptId: "22222222-2222-4222-8222-222222222222",
      descriptorDigest: `sha256:${"3".repeat(64)}`, descriptor: { bound: true } };
    const first = new NativeQemuSchedulerStore(path, () => 1_000);
    first.admit({ projectId: "project-a", admissionGeneration: "admission-1", leaseExpiresAt: 100_000,
      policyRevision: event.policyRevision, requiredJobSetRevision: event.requiredJobSetRevision,
      requiredQemuJobs: ["integration"] });
    first.enqueue("admission-1", event);
    const claim = first.reserve({ requestId, hostId: "node-a", capacity: "kvm-1", leaseMilliseconds: 60_000 });
    if (claim === undefined) throw new TypeError("claim fixture");
    first.activate(claim.claimId, attempt);
    first.close();

    // When
    const restarted = new NativeQemuSchedulerStore(path, () => 1_000);
    stores.push(restarted);
    const replay = restarted.assignment(requestId, "node-a", "kvm-1");

    // Then
    expect(replay).toEqual({ claim, attempt });
  });
});
