import { link, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  http,
  incompleteRun,
  launchRecords,
  readEvents,
  spawnRecords,
  startService,
  waitForExit,
  waitForObservation,
  type ServiceFixture
} from "./qemuServiceTestSupport.js";
import { socketLeasePath } from "../../project/.dim/qemu-service-artifacts.mjs";

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function survivingArtifacts(fixture: ServiceFixture): Promise<readonly string[]> {
  const paths = [fixture.runsRoot, fixture.socketPath, socketLeasePath(fixture.socketPath),
    resolve(fixture.root, "service-owner.json")];
  const observations = await Promise.all(paths.map(async (path) => {
    try {
      await lstat(path);
      return path;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }));
  return observations.filter((path) => path !== undefined);
}

describe("QEMU service shutdown", () => {
  it("preserves a replaced socket while removing owned shutdown artifacts", async () => {
    const fixture = await startService("hold");
    const ownerPath = resolve(fixture.root, "service-owner.json");
    await rm(fixture.socketPath);
    const replacementSocket = createServer();
    await new Promise<void>((resolveListen) => replacementSocket.listen(fixture.socketPath, resolveListen));

    fixture.process.kill("SIGTERM");
    await waitForExit(fixture, 2_000);

    expect.soft((await lstat(fixture.socketPath)).isSocket()).toBe(true);
    await expect(lstat(ownerPath)).rejects.toThrow();
    await expect(lstat(socketLeasePath(fixture.socketPath))).rejects.toThrow();
    await new Promise<void>((resolveClose) => replacementSocket.close(() => resolveClose()));
  });

  it.each(["missing", "mismatched"] as const)("fails closed before close when the lease is %s", async (leaseState) => {
    const fixture = await startService("hold");
    const leasePath = socketLeasePath(fixture.socketPath);
    const ownerPath = resolve(fixture.root, "service-owner.json");
    const [socketBefore, ownerBefore, runsBefore, ownerContent, runEntries] = await Promise.all([
      lstat(fixture.socketPath, { bigint: true }), lstat(ownerPath, { bigint: true }),
      lstat(fixture.runsRoot, { bigint: true }), readFile(ownerPath, "utf8"), readdir(fixture.runsRoot),
    ]);
    await rm(leasePath);
    let foreignSocket: ReturnType<typeof createServer> | undefined;
    let leaseBefore: { readonly dev: bigint; readonly ino: bigint } | undefined;
    if (leaseState === "mismatched") {
      const server = createServer();
      foreignSocket = server;
      const foreignPath = resolve(fixture.root, "foreign-lease.sock");
      await new Promise<void>((resolveListen) => server.listen(foreignPath, resolveListen));
      await link(foreignPath, leasePath);
      leaseBefore = await lstat(leasePath, { bigint: true });
    }

    fixture.process.kill("SIGTERM");
    const exited = await waitForExit(fixture, 2_000);

    const [socketAfter, ownerAfter, runsAfter] = await Promise.all([
      lstat(fixture.socketPath, { bigint: true }), lstat(ownerPath, { bigint: true }),
      lstat(fixture.runsRoot, { bigint: true }),
    ]);
    expect.soft(exited, "lease failure must produce bounded exit").toBe(true);
    expect.soft(fixture.process.exitCode).not.toBe(0);
    expect.soft({ device: socketAfter.dev, inode: socketAfter.ino })
      .toEqual({ device: socketBefore.dev, inode: socketBefore.ino });
    expect.soft({ device: ownerAfter.dev, inode: ownerAfter.ino })
      .toEqual({ device: ownerBefore.dev, inode: ownerBefore.ino });
    expect.soft({ device: runsAfter.dev, inode: runsAfter.ino })
      .toEqual({ device: runsBefore.dev, inode: runsBefore.ino });
    expect.soft(await readFile(ownerPath, "utf8")).toBe(ownerContent);
    expect.soft(await readdir(fixture.runsRoot)).toEqual(runEntries);
    if (leaseBefore) {
      const leaseAfter = await lstat(leasePath, { bigint: true });
      expect({ device: leaseAfter.dev, inode: leaseAfter.ino })
        .toEqual({ device: leaseBefore.dev, inode: leaseBefore.ino });
    } else await expect(lstat(leasePath)).rejects.toThrow();
    if (foreignSocket?.listening) {
      const server = foreignSocket;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("terminates an active launcher and cleans its run before reporting lease failure", async () => {
    const fixture = await startService("hold");
    await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture, "ready\n");
    const launcherPid = Number.parseInt(await readFile(fixture.launcherPidFile, "utf8"), 10);
    await rm(socketLeasePath(fixture.socketPath));

    fixture.process.kill("SIGTERM");
    expect.soft(await waitForExit(fixture, 5_000)).toBe(true);

    expect.soft(fixture.process.exitCode).not.toBe(0);
    expect.soft(await readFile(fixture.launcherStopFile, "utf8")).toBe("stopped");
    expect.soft(() => process.kill(launcherPid, 0)).toThrow();
    expect.soft(await readdir(fixture.runsRoot)).toEqual([]);
    expect((await lstat(fixture.socketPath)).isSocket()).toBe(true);
  });

  it("drains an admitted incomplete body before bounded exit without launching or retaining artifacts", async () => {
    // Given
    const fixture = await startService("hold");
    const run = incompleteRun(fixture);
    const responseSettled = run.response.then(() => undefined, () => undefined);
    await run.continued;

    // When
    fixture.process.kill("SIGTERM");
    const exitedWhileIncomplete = await waitForExit(fixture);
    run.abort();
    await responseSettled;
    if (!exitedWhileIncomplete) await waitForExit(fixture);

    // Then
    expect.soft(exitedWhileIncomplete, "SIGTERM must close an incomplete admitted request").toBe(true);
    expect.soft(await spawnRecords(fixture)).toEqual([]);
    expect.soft(await launchRecords(fixture)).toEqual([]);
    expect(await survivingArtifacts(fixture)).toEqual([]);
  });

  it("closes a raw incomplete-header connection before service exit", async () => {
    const fixture = await startService("hold");
    const client = createConnection(fixture.socketPath);
    await new Promise<void>((resolveConnect, rejectConnect) => {
      client.once("connect", resolveConnect);
      client.once("error", rejectConnect);
    });
    client.write("POST /v1/run HTTP/1.1\r\nContent-Length: 10\r\n");
    const closed = new Promise<void>((resolveClose, rejectClose) => {
      client.once("close", () => resolveClose());
      client.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNRESET") resolveClose();
        else rejectClose(error);
      });
    });

    fixture.process.kill("SIGTERM");
    const exited = await waitForExit(fixture, 2_000);
    await closed;

    expect.soft(exited).toBe(true);
    expect(await survivingArtifacts(fixture)).toEqual([]);
  });

  it("cancels an observed partial snapshot before exit without launching or retaining artifacts", async () => {
    // Given
    const fixture = await startService("hold");
    const input = resolve(fixture.sourceRoot, "large-input");
    const fileCount = 512;
    const payload = Buffer.alloc(8 * 1024, 0x61);
    await mkdir(input);
    await Promise.all(Array.from({ length: fileCount }, (_value, index) =>
      writeFile(resolve(input, `${String(index).padStart(4, "0")}.data`), payload)
    ));

    // When
    const run = http(fixture, {
      body: { inputs: [{ name: "large", path: input }] }, method: "POST", path: "/v1/run"
    });
    const runSettled = run.then(() => undefined, () => undefined);
    const partialDestination = await waitForObservation(async () => {
      try {
        const runNames = await readdir(fixture.runsRoot);
        const runName = runNames[0];
        if (runName === undefined) return undefined;
        const destination = resolve(fixture.runsRoot, runName, "inputs/large");
        const copied = await readdir(destination);
        return copied.length > 0 && copied.length < fileCount ? destination : undefined;
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    });
    const copiedBeforeSignal = await readdir(partialDestination);
    fixture.process.kill("SIGTERM");
    const exited = await waitForExit(fixture, 2_000);
    await runSettled;

    // Then
    expect.soft(copiedBeforeSignal.length).toBeGreaterThan(0);
    expect.soft(copiedBeforeSignal.length).toBeLessThan(fileCount);
    expect.soft(exited, "SIGTERM must bound active snapshot shutdown").toBe(true);
    expect.soft((await spawnRecords(fixture)).filter((record) => record.command === "bash")).toEqual([]);
    expect.soft(await launchRecords(fixture)).toEqual([]);
    expect(await survivingArtifacts(fixture)).toEqual([]);
  }, 10_000);

  it("waits for a launched detached child to close and cleans ownership artifacts before exit", async () => {
    // Given
    const fixture = await startService("hold");
    const input = resolve(fixture.sourceRoot, "input");
    await mkdir(input);
    await writeFile(resolve(input, "payload"), "fixture\n");
    const started = await http(fixture, {
      body: { inputs: [{ name: "fixture", path: input }] }, method: "POST", path: "/v1/run"
    });
    await readEvents(fixture, "ready\n");

    // When
    fixture.process.kill("SIGTERM");
    const exited = await waitForExit(fixture, 5_000);
    const launcherStopped = await readFile(fixture.launcherStopFile, "utf8");

    // Then
    expect.soft(started.status).toBe(202);
    expect.soft(exited, "service exit must follow detached launcher close").toBe(true);
    expect.soft(launcherStopped).toBe("stopped");
    expect(await survivingArtifacts(fixture)).toEqual([]);
  });
});
