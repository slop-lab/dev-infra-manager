import { lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { socketLeasePath } from "../../.dim/qemu-service-artifacts.mjs";
import {
  http,
  readEvents,
  startService,
  waitForExit,
  waitForObservation,
} from "./qemuServiceTestSupport.js";

async function triggerRuntimeServerErrors(
  fixture: Awaited<ReturnType<typeof startService>>, count: number, signal = false,
): Promise<void> {
  const temporary = `${fixture.runtimeServerErrorTriggerFile}.prepared`;
  await writeFile(temporary, JSON.stringify({ count, signal }));
  await rename(temporary, fixture.runtimeServerErrorTriggerFile);
}

function identity(stats: Awaited<ReturnType<typeof lstat>>): { readonly device: bigint; readonly inode: bigint } {
  return { device: stats.dev, inode: stats.ino };
}

async function serviceEvidence(fixture: Awaited<ReturnType<typeof startService>>) {
  const ownerPath = resolve(fixture.root, "service-owner.json");
  const [owner, socket, lease, runs, ownerContent, runEntries] = await Promise.all([
    lstat(ownerPath, { bigint: true }),
    lstat(fixture.socketPath, { bigint: true }),
    lstat(socketLeasePath(fixture.socketPath), { bigint: true }),
    lstat(fixture.runsRoot, { bigint: true }),
    readFile(ownerPath, "utf8"),
    readdir(fixture.runsRoot),
  ]);
  return { lease, owner, ownerContent, runEntries, runs, socket };
}

function expectSameEvidence(
  before: Awaited<ReturnType<typeof serviceEvidence>>,
  after: Awaited<ReturnType<typeof serviceEvidence>>,
): void {
  expect.soft(identity(after.owner)).toEqual(identity(before.owner));
  expect.soft(identity(after.socket)).toEqual(identity(before.socket));
  expect.soft(identity(after.lease)).toEqual(identity(before.lease));
  expect.soft(identity(after.runs)).toEqual(identity(before.runs));
  expect.soft(after.ownerContent).toBe(before.ownerContent);
  expect.soft(after.runEntries).toEqual(before.runEntries);
}

function groupIsGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && error.message.includes("ESRCH")) return true;
    throw error;
  }
}

describe("QEMU service runtime server errors", () => {
  it("preserves the snapshot when fatal shutdown owns finalization before cleanup", async () => {
    // Given
    const fixture = await startService("hold", { blockSnapshotRemoval: true });
    await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture, "ready\n");
    const [snapshotName] = await readdir(fixture.runsRoot);
    if (snapshotName === undefined) throw new TypeError("active snapshot was not published");
    const snapshotRoot = resolve(fixture.runsRoot, snapshotName);

    // When
    await triggerRuntimeServerErrors(fixture, 1);
    const exited = await waitForExit(fixture, 5_000);

    // Then
    expect.soft(exited).toBe(true);
    expect.soft(fixture.process.exitCode).toBe(1);
    expect.soft((await lstat(snapshotRoot)).isDirectory()).toBe(true);
    await expect(readFile(fixture.snapshotRemovalStartedFile, "utf8")).rejects.toThrow();
  }, 6_000);

  it("finishes cleanup that won before fatal shutdown while retaining remaining evidence", async () => {
    // Given
    const fixture = await startService("hold", { blockSnapshotRemoval: true });
    await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture, "ready\n");
    const ownerPath = resolve(fixture.root, "service-owner.json");

    // When
    const cancellation = http(fixture, { method: "DELETE", path: "/v1/run" }).catch(() => undefined);
    await waitForObservation(async () => {
      try { return (await readFile(fixture.snapshotRemovalStartedFile, "utf8")).trim() || undefined; }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    });
    await triggerRuntimeServerErrors(fixture, 1);
    await writeFile(fixture.snapshotRemovalReleaseFile, "release\n");
    const exited = await waitForExit(fixture, 5_000);
    await cancellation;

    // Then
    expect.soft(exited).toBe(true);
    expect.soft(fixture.process.exitCode).toBe(1);
    expect.soft(await readdir(fixture.runsRoot)).toEqual([]);
    expect.soft((await lstat(ownerPath)).isFile()).toBe(true);
    expect.soft((await lstat(fixture.socketPath)).isSocket()).toBe(true);
    expect((await lstat(socketLeasePath(fixture.socketPath))).isSocket()).toBe(true);
  }, 7_000);

  it("enters bounded fatal shutdown on the first error after accepting", async () => {
    // Given
    const fixture = await startService("hold");
    const before = await serviceEvidence(fixture);

    // When
    await triggerRuntimeServerErrors(fixture, 1);
    const exited = await waitForExit(fixture);
    const acceptingStatus = exited ? undefined : (await http(fixture, { method: "GET", path: "/v1/status" })).status;

    // Then
    expect.soft({ acceptingStatus, exited }, "runtime error must not remain swallowed while accepting")
      .toEqual({ acceptingStatus: undefined, exited: true });
    expect.soft(fixture.process.exitCode).toBe(1);
    expectSameEvidence(before, await serviceEvidence(fixture));
    expect.soft(await readFile(fixture.runtimeServerErrorRecordFile, "utf8"))
      .toBe("DIM_TEST_RUNTIME_SERVER_ERROR_1:listeners=1\n");
    expect.soft(await readFile(fixture.serverCloseRecordFile, "utf8")).toBe("close\n");
    expect(fixture.stderr().match(/DIM_TEST_RUNTIME_SERVER_ERROR_1/g)).toHaveLength(1);
  });

  it("coalesces two runtime errors and SIGTERM into one fatal close and one nonzero exit", async () => {
    // Given
    const fixture = await startService("hold");
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture, "ready\n");
    const launcherPid = Number.parseInt(await readFile(fixture.launcherPidFile, "utf8"), 10);
    const before = await serviceEvidence(fixture);
    expect.soft(started.status).toBe(202);
    expect.soft(before.runEntries).toHaveLength(1);
    let exitEvents = 0;
    fixture.process.on("exit", () => { exitEvents += 1; });

    // When
    await triggerRuntimeServerErrors(fixture, 2, true);
    const exited = await waitForExit(fixture);

    // Then
    expect.soft(exited, "coalesced fatal shutdown must be bounded").toBe(true);
    expect.soft(fixture.process.exitCode).toBe(1);
    expect.soft(exitEvents).toBe(1);
    expectSameEvidence(before, await serviceEvidence(fixture));
    expect.soft(groupIsGone(launcherPid), "fatal shutdown must remove the active process group").toBe(true);
    expect.soft(await readFile(fixture.runtimeServerErrorRecordFile, "utf8"))
      .toBe("DIM_TEST_RUNTIME_SERVER_ERROR_1:listeners=1\nDIM_TEST_RUNTIME_SERVER_ERROR_2:listeners=1\nSIGTERM\n");
    expect(await readFile(fixture.serverCloseRecordFile, "utf8")).toBe("close\n");
  });

  it("upgrades SIGTERM-first teardown to one fatal exit without competing for listener close", async () => {
    // Given
    const fixture = await startService("hold", { ignoreLauncherTerm: true });
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture, "ready\n");
    const launcherPid = Number.parseInt(await readFile(fixture.launcherPidFile, "utf8"), 10);
    expect.soft(started.status).toBe(202);

    // When
    fixture.process.kill("SIGTERM");
    await waitForObservation(async () => {
      try { return (await readFile(fixture.groupSignalRecordFile, "utf8")).includes("SIGTERM") ? true : undefined; }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    });
    await triggerRuntimeServerErrors(fixture, 1);
    const exited = await waitForExit(fixture, 6_000);

    // Then
    expect.soft(exited, "fatal upgrade must await the bounded graceful owner").toBe(true);
    expect.soft(fixture.process.exitCode).toBe(1);
    expect.soft(groupIsGone(launcherPid)).toBe(true);
    expect.soft(await readFile(fixture.serverCloseRecordFile, "utf8")).toBe("close\n");
    await expect(lstat(resolve(fixture.root, "service-owner.json"))).rejects.toThrow();
    await expect(lstat(fixture.socketPath)).rejects.toThrow();
    await expect(lstat(socketLeasePath(fixture.socketPath))).rejects.toThrow();
    await expect(lstat(fixture.runsRoot)).rejects.toThrow();
  }, 7_000);

  it("closes once after bounded fatal group termination reports a residual member", async () => {
    // Given
    const fixture = await startService("hold", { residualProcessGroup: true });
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture, "ready\n");
    const before = await serviceEvidence(fixture);
    expect.soft(started.status).toBe(202);

    // When
    await triggerRuntimeServerErrors(fixture, 1);
    const exited = await waitForExit(fixture, 6_000);

    // Then
    expect.soft(exited, "residual fatal shutdown must remain bounded").toBe(true);
    expect.soft(fixture.process.exitCode).toBe(1);
    expectSameEvidence(before, await serviceEvidence(fixture));
    expect.soft(await readFile(fixture.serverCloseRecordFile, "utf8")).toBe("close\n");
    expect(fixture.stderr()).toContain("remained live after SIGKILL");
  }, 7_000);
});