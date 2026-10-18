import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeRootCiHostClient,
  type NativeRootCiHostClient
} from "../../../../core/packages/managed/src/nativeRootCiHostClient.js";
import { serveNativeRootCiHostCapacity } from "../../../../core/packages/managed/src/nativeRootCiHostWorker.js";
import { NativeHostFinalizationUncertainError } from "../../../../core/packages/managed/src/nativeOrdinaryExecutorErrors.js";
import { tryAcquireKernelGuard } from "../../../../core/packages/core/src/lifecycleLockGuard.js";
import { bundleSecrets } from "../../native-git/test/bundleConfigFixture.js";
import { generationId } from "../../native-git/test/nativeRootImportFinalizeFixture.js";
import { ExecutorRunner } from "./nativeOrdinaryExecutorFixture.js";
import { claimRequest, hostAuthorization, post, reservationFixture, rows,
  type ReservationFixture } from "./nativeRootClaimReservationFixture.js";
import { resultRows } from "./nativeRootHostResultFixture.js";

const fixtures: ReservationFixture[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native root CI installed host capacity", () => {
  it("executes one reserved candidate with Sysbox, cleans it, and reports schema-3 evidence", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-worker");
    fixtures.push(fixture);
    const controller = new AbortController();
    const base = client(fixture);
    const observed: NativeRootCiHostClient = {
      ...base,
      async report(request, signal) {
        await base.report(request, signal);
        controller.abort();
      }
    };
    const runner = new ExecutorRunner();
    const journalPath = join(await temporaryRoot(), "primary.json");

    // When
    await serveNativeRootCiHostCapacity({ client: observed, runner, gitExecutable: "/usr/bin/git",
      nativeGitEndpoint: fixture.nativeOrigin, journalPath, idleDelayMilliseconds: 1 }, controller.signal);

    // Then
    const dockerRun = runner.calls.find(({ args }) => args[0] === "run");
    expect(dockerRun?.args).toContain("sysbox-runc");
    expect(runner.calls.some(({ args }) => args[0] === "container" && args[1] === "rm")).toBe(true);
    const rows = resultRows(fixture.database);
    const result = Array.isArray(rows.results) ? rows.results[0] : undefined;
    if (typeof result !== "object" || result === null) throw new TypeError("host result row is missing");
    const request = JSON.parse(String(Reflect.get(result, "request_json")));
    expect(request.schemaVersion).toBe(2);
    expect(request.terminalEvent.schemaVersion).toBe(3);
    expect(request.terminalEvent.payload.executionKind).toBe("ordinary-sysbox");
  }, 30_000);

  it("stops an idle capacity after one empty reservation without fabricating work", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-idle");
    fixtures.push(fixture);
    expect((await post(fixture.origin, "/v1/host-claims", hostAuthorization("host-b"),
      claimRequest("20000000-0000-4000-8000-000000000901", "host-b", "backup"))).status).toBe(201);
    const controller = new AbortController();
    const base = client(fixture);
    let reservations = 0;
    const observed: NativeRootCiHostClient = {
      ...base,
      async reserve(request, signal) {
        reservations += 1;
        const claim = await base.reserve(request, signal);
        controller.abort();
        return claim;
      }
    };

    // When
    await serveNativeRootCiHostCapacity({ client: observed, runner: new ExecutorRunner(),
      gitExecutable: "/usr/bin/git", nativeGitEndpoint: fixture.nativeOrigin,
      journalPath: join(await temporaryRoot(), "primary.json"), idleDelayMilliseconds: 1 }, controller.signal);

    // Then
    expect(reservations).toBe(1);
  }, 20_000);

  it("replays the exact durable result after acknowledgement is lost without re-executing", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-result-replay");
    fixtures.push(fixture);
    const base = client(fixture);
    const runner = new ExecutorRunner();
    const journalPath = join(await temporaryRoot(), "primary.json");
    const failedAcknowledgement: NativeRootCiHostClient = {
      ...base,
      async report(request, signal) {
        await base.report(request, signal);
        throw new NativeHostFinalizationUncertainError("acknowledgement transport was lost");
      }
    };

    // When
    await expect(serveNativeRootCiHostCapacity({ client: failedAcknowledgement, runner,
      gitExecutable: "/usr/bin/git", nativeGitEndpoint: fixture.nativeOrigin,
      journalPath, idleDelayMilliseconds: 1 }, new AbortController().signal)).rejects.toThrow(/acknowledgement/);
    const runsBeforeReplay = runner.calls.filter(({ args }) => args[0] === "run").length;
    const controller = new AbortController();
    const replayClient: NativeRootCiHostClient = {
      ...base,
      async report(request, signal) {
        await base.report(request, signal);
        controller.abort();
      }
    };
    await serveNativeRootCiHostCapacity({ client: replayClient, runner,
      gitExecutable: "/usr/bin/git", nativeGitEndpoint: fixture.nativeOrigin,
      journalPath, idleDelayMilliseconds: 1 }, controller.signal);

    // Then
    expect(runner.calls.filter(({ args }) => args[0] === "run")).toHaveLength(runsBeforeReplay);
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("recovers a claimed attempt after executor failure and retains no owned resource", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-recovery");
    fixtures.push(fixture);
    const runner = new ExecutorRunner();
    runner.imageMismatch = true;
    const journalPath = join(await temporaryRoot(), "primary.json");

    // When
    const running = serveNativeRootCiHostCapacity({ client: client(fixture), runner,
      gitExecutable: "/usr/bin/git", nativeGitEndpoint: fixture.nativeOrigin,
      journalPath, idleDelayMilliseconds: 1 }, new AbortController().signal);

    // Then
    await expect(running).rejects.toThrow(/image digest/);
    const claims = rows(fixture.database).claims;
    expect(claims).toEqual([expect.objectContaining({ state: "released" })]);
    expect(runner.calls.some(({ args }) => args[0] === "run")).toBe(false);
    await expect(stat(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("cancels active execution on shutdown, cleans it, and reports terminal evidence", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-shutdown");
    fixtures.push(fixture);
    const controller = new AbortController();
    const runner = new ExecutorRunner();
    runner.waitForAbort = true;
    runner.logsWaitForAbort = true;
    runner.onWait = () => controller.abort();

    // When
    await serveNativeRootCiHostCapacity({ client: client(fixture), runner,
      gitExecutable: "/usr/bin/git", nativeGitEndpoint: fixture.nativeOrigin,
      journalPath: join(await temporaryRoot(), "primary.json"), idleDelayMilliseconds: 1 }, controller.signal);

    // Then
    expect(runner.calls.some(({ args }) => args[0] === "container" && args[1] === "rm")).toBe(true);
    const result = (resultRows(fixture.database).results as readonly Record<string, unknown>[])[0];
    expect(JSON.parse(String(result?.request_json)).terminalEvent.payload.completion.kind).toBe("cancelled");
  }, 30_000);

  it("fences one demand across concurrent capacities on separate nodes", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-concurrent");
    fixtures.push(fixture);
    const controller = new AbortController();
    const runner = new ExecutorRunner();
    const primary = reportingClient(client(fixture), controller);
    const backup = reportingClient(client(fixture, "host-b", "backup"), controller);
    const root = await temporaryRoot();

    // When
    await Promise.all([
      serveNativeRootCiHostCapacity({ client: primary, runner, gitExecutable: "/usr/bin/git",
        nativeGitEndpoint: fixture.nativeOrigin, journalPath: join(root, "primary.json"), idleDelayMilliseconds: 1 }, controller.signal),
      serveNativeRootCiHostCapacity({ client: backup, runner, gitExecutable: "/usr/bin/git",
        nativeGitEndpoint: fixture.nativeOrigin, journalPath: join(root, "backup.json"), idleDelayMilliseconds: 1 }, controller.signal)
    ]);

    // Then
    expect(runner.calls.filter(({ args }) => args[0] === "run")).toHaveLength(1);
    expect((rows(fixture.database).claims as readonly unknown[])).toHaveLength(1);
    expect((resultRows(fixture.database).results as readonly unknown[])).toHaveLength(1);
  }, 30_000);

  it("refuses a second process before attestation when the capacity journal is locked", async () => {
    // Given
    const fixture = await reservationFixture("native-root-ci-host-exclusive");
    fixtures.push(fixture);
    const journalPath = join(await temporaryRoot(), "primary.json");
    const guard = await tryAcquireKernelGuard(`${journalPath}.guard`);
    if (guard === undefined) throw new TypeError("test capacity guard was not acquired");

    // When
    const running = serveNativeRootCiHostCapacity({ client: client(fixture), runner: new ExecutorRunner(),
      gitExecutable: "/usr/bin/git", nativeGitEndpoint: fixture.nativeOrigin,
      journalPath, idleDelayMilliseconds: 1 }, new AbortController().signal);

    // Then
    try { await expect(running).rejects.toThrow(/already served/); }
    finally { await guard.release(); }
    expect(rows(fixture.database).claims).toEqual([]);
  }, 20_000);
});

function client(fixture: ReservationFixture, hostId: "host-a" | "host-b" = "host-a",
  capacity: "primary" | "backup" = "primary"): NativeRootCiHostClient {
  return createNativeRootCiHostClient({ hostId, capacity, generationId,
    ordinaryCi: { endpoint: fixture.origin, serviceId: "ordinary-main",
      credential: { username: hostId, password: hostId === "host-a"
        ? bundleSecrets.host : Buffer.alloc(32, 83).toString("base64url") } },
    nativeGit: { endpoint: fixture.nativeOrigin, serviceId: "native-main" } });
}

function reportingClient(base: NativeRootCiHostClient, controller: AbortController): NativeRootCiHostClient {
  return { ...base, async report(request, signal) { await base.report(request, signal); controller.abort(); } };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-ci-host-worker-"));
  roots.push(root);
  return root;
}
