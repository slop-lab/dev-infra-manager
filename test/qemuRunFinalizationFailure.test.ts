import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { socketLeasePath } from "../../project/.dim/qemu-service-artifacts.mjs";
import { http, readEvents, spawnRecords, startService, waitForExit, waitForObservation } from "./qemuServiceTestSupport.js";

const unsupportedServers: Server[] = [];

function identity(stats: Awaited<ReturnType<typeof lstat>>): { readonly device: bigint; readonly inode: bigint } {
  return { device: stats.dev, inode: stats.ino };
}

afterEach(async () => {
  await Promise.all(unsupportedServers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
  })));
});

describe("QEMU rejected run finalization", () => {
  it("exits fatally with exact evidence when rejected snapshot removal fails", async () => {
    // Given
    const fixture = await startService("exit", { rejectSnapshotRemoval: true });
    const stderr: Buffer[] = [];
    fixture.process.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const ownerPath = resolve(fixture.root, "service-owner.json");
    const leasePath = socketLeasePath(fixture.socketPath);
    const snapshotRemovalRecordFile = resolve(fixture.root, "rejected-snapshot-removal.record");
    const unsupported = resolve(fixture.sourceRoot, "unsupported");
    await mkdir(unsupported);
    const special = createServer();
    unsupportedServers.push(special);
    await new Promise<void>((resolveListen, rejectListen) => {
      special.once("error", rejectListen);
      special.listen(resolve(unsupported, "entry.sock"), resolveListen);
    });
    const [ownerBefore, socketBefore, leaseBefore, runsBefore, ownerContent] = await Promise.all([
      lstat(ownerPath, { bigint: true }), lstat(fixture.socketPath, { bigint: true }),
      lstat(leasePath, { bigint: true }), lstat(fixture.runsRoot, { bigint: true }), readFile(ownerPath, "utf8"),
    ]);

    // When
    const rejection = http(fixture, {
      body: { inputs: [{ name: "unsupported", path: unsupported }] }, method: "POST", path: "/v1/run",
    }).catch(() => undefined);
    const snapshotRoot = (await waitForObservation(async () => {
      try { return (await readFile(snapshotRemovalRecordFile, "utf8")).trim().split("\n").at(-1); }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    }));
    if (snapshotRoot === undefined || snapshotRoot === "") throw new TypeError("failed snapshot identity was not recorded");
    const snapshotBefore = await lstat(snapshotRoot, { bigint: true });
    const later = await http(fixture, {
      body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run",
    }).catch(() => undefined);
    const exitStartedAt = Date.now();
    const exited = await waitForExit(fixture, 1_000);
    const exitElapsedMilliseconds = Date.now() - exitStartedAt;
    await rejection;

    // Then
    const [ownerAfter, socketAfter, leaseAfter, runsAfter, snapshotAfter] = await Promise.all([
      lstat(ownerPath, { bigint: true }), lstat(fixture.socketPath, { bigint: true }),
      lstat(leasePath, { bigint: true }), lstat(fixture.runsRoot, { bigint: true }),
      lstat(snapshotRoot, { bigint: true }),
    ]);
    expect.soft(exited, "fatal rejected-run cleanup must exit within one second").toBe(true);
    expect.soft(exitElapsedMilliseconds).toBeLessThan(1_000);
    expect.soft(fixture.process.exitCode).toBe(1);
    expect.soft(later?.status).not.toBe(202);
    expect.soft(await spawnRecords(fixture), "pre-launch rejection must not spawn a child").toEqual([]);
    expect.soft(snapshotRoot.startsWith(`${fixture.runsRoot}/run-`)).toBe(true);
    expect.soft(await readdir(fixture.runsRoot)).toEqual([snapshotRoot.slice(fixture.runsRoot.length + 1)]);
    expect.soft(identity(snapshotAfter)).toEqual(identity(snapshotBefore));
    expect.soft(identity(ownerAfter)).toEqual(identity(ownerBefore));
    expect.soft(identity(socketAfter)).toEqual(identity(socketBefore));
    expect.soft(identity(leaseAfter)).toEqual(identity(leaseBefore));
    expect.soft(identity(runsAfter)).toEqual(identity(runsBefore));
    expect.soft(await readFile(ownerPath, "utf8")).toBe(ownerContent);
    const stderrText = Buffer.concat(stderr).toString("utf8");
    expect.soft(stderrText).toContain("input 'unsupported' contains an unsupported entry type");
    expect(stderrText).toContain(`DIM_TEST_SNAPSHOT_RM_FAILURE ${snapshotRoot}`);
  }, 5_000);

  it.each([
    ["residual process group", { residualProcessGroup: true }, "remained live after SIGKILL"],
    ["snapshot removal failure", { rejectSnapshotRemoval: true }, "DIM_TEST_SNAPSHOT_RM_FAILURE"],
  ] as const)("escalates a cancel-only %s finalization rejection to fatal shutdown", async (_kind, options, diagnostic) => {
    // Given
    const fixture = await startService("hold", options);
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture, "ready\n");
    expect.soft(started.status).toBe(202);

    // When
    const cancellation = http(fixture, { method: "DELETE", path: "/v1/run" }).catch(() => undefined);
    const exited = await waitForExit(fixture, 6_000);
    await cancellation;

    // Then
    expect.soft(exited, "cancel finalization rejection must stop the service").toBe(true);
    expect.soft(fixture.process.exitCode).toBe(1);
    expect(fixture.stderr()).toContain(diagnostic);
  }, 7_000);
});
