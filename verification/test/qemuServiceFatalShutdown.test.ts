import { link, lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { socketLeasePath } from "../../.dim/qemu-service-artifacts.mjs";
import { http, readEvents, startService, waitForExit, waitForObservation } from "./qemuServiceTestSupport.js";

const foreignServers: Server[] = [];

function identity(stats: Awaited<ReturnType<typeof lstat>>): { readonly device: bigint; readonly inode: bigint } {
  return { device: stats.dev, inode: stats.ino };
}

async function receive(path: string): Promise<string> {
  return new Promise((resolveData, rejectData) => {
    const chunks: Buffer[] = [];
    const connection = createConnection(path);
    connection.on("data", (chunk: Buffer) => chunks.push(chunk));
    connection.once("end", () => resolveData(Buffer.concat(chunks).toString("utf8")));
    connection.once("error", rejectData);
  });
}

afterEach(async () => {
  await Promise.all(foreignServers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
  })));
});

describe("QEMU service fatal shutdown", () => {
  it("preserves a foreign public socket and owned evidence with a valid lease", async () => {
    // Given
    const fixture = await startService("hold");
    await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture, "ready\n");
    const ownerPath = resolve(fixture.root, "service-owner.json");
    const leasePath = socketLeasePath(fixture.socketPath);
    const runEntries = await readdir(fixture.runsRoot);
    const [ownerBefore, leaseBefore, runsBefore, ownerContent] = await Promise.all([
      lstat(ownerPath, { bigint: true }), lstat(leasePath, { bigint: true }),
      lstat(fixture.runsRoot, { bigint: true }), readFile(ownerPath, "utf8"),
    ]);
    await rm(fixture.socketPath);
    const foreignPath = resolve(fixture.root, "foreign-public.sock");
    const foreign = createServer((connection) => connection.end("foreign public socket alive\n"));
    foreignServers.push(foreign);
    await new Promise<void>((resolveListen, rejectListen) => {
      foreign.once("error", rejectListen);
      foreign.listen(foreignPath, resolveListen);
    });
    await link(foreignPath, fixture.socketPath);
    const foreignBefore = await lstat(fixture.socketPath, { bigint: true });

    // When
    const temporary = `${fixture.runtimeServerErrorTriggerFile}.prepared`;
    await writeFile(temporary, JSON.stringify({ count: 1, signal: false }));
    await rename(temporary, fixture.runtimeServerErrorTriggerFile);
    const exited = await waitForExit(fixture, 5_000);

    // Then
    const [ownerAfter, publicAfter, leaseAfter, runsAfter] = await Promise.all([
      lstat(ownerPath, { bigint: true }), lstat(fixture.socketPath, { bigint: true }),
      lstat(leasePath, { bigint: true }), lstat(fixture.runsRoot, { bigint: true }),
    ]);
    expect.soft(exited).toBe(true);
    expect.soft(fixture.process.exitCode).toBe(1);
    expect.soft(identity(publicAfter)).toEqual(identity(foreignBefore));
    expect.soft(identity(ownerAfter)).toEqual(identity(ownerBefore));
    expect.soft(identity(leaseAfter)).toEqual(identity(leaseBefore));
    expect.soft(identity(runsAfter)).toEqual(identity(runsBefore));
    expect.soft(await readFile(ownerPath, "utf8")).toBe(ownerContent);
    expect.soft(await readdir(fixture.runsRoot)).toEqual(runEntries);
    expect.soft(await receive(fixture.socketPath)).toBe("foreign public socket alive\n");
    expect(await receive(foreignPath)).toBe("foreign public socket alive\n");
  }, 7_000);

  it.each(["missing", "mismatched"] as const)(
    "preserves the live service and run evidence when the socket lease is %s",
    async (leaseState) => {
      // Given
      const fixture = await startService("hold", { leaderExits: true, residualProcessGroup: true });
      const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
      expect(started, started.body).toMatchObject({ status: 202 });
      await waitForObservation(async () => {
        try { return await readFile(fixture.descendantPidFile, "utf8"); }
        catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        }
      });
      const ownerPath = resolve(fixture.root, "service-owner.json");
      const leasePath = socketLeasePath(fixture.socketPath);
      const runEntries = await readdir(fixture.runsRoot);
      const snapshotName = runEntries[0];
      if (snapshotName === undefined) throw new TypeError("active run snapshot was not published");
      const snapshotRoot = resolve(fixture.runsRoot, snapshotName);
      const inputsRoot = resolve(snapshotRoot, "inputs");
      const [ownerBefore, socketBefore, runsBefore, snapshotBefore, inputsBefore, ownerContent] = await Promise.all([
        lstat(ownerPath, { bigint: true }), lstat(fixture.socketPath, { bigint: true }),
        lstat(fixture.runsRoot, { bigint: true }), lstat(snapshotRoot, { bigint: true }),
        lstat(inputsRoot, { bigint: true }), readFile(ownerPath, "utf8"),
      ]);
      await rm(leasePath);
      let foreignPath: string | undefined;
      if (leaseState === "mismatched") {
        foreignPath = resolve(fixture.root, "foreign.sock");
        const foreignServer = createServer((connection) => connection.end("foreign socket alive\n"));
        foreignServers.push(foreignServer);
        await new Promise<void>((resolveListen, rejectListen) => {
          foreignServer.once("error", rejectListen);
          foreignServer.listen(foreignPath, resolveListen);
        });
        await link(foreignPath, leasePath);
      }
      const leaseBefore = leaseState === "mismatched" ? await lstat(leasePath, { bigint: true }) : undefined;

      // When
      const exitStartedAt = Date.now();
      const exited = await waitForExit(fixture, 6_000);
      const exitElapsedMilliseconds = Date.now() - exitStartedAt;

      // Then
      const [ownerAfter, socketAfter, runsAfter, snapshotAfter, inputsAfter] = await Promise.all([
        lstat(ownerPath, { bigint: true }), lstat(fixture.socketPath, { bigint: true }),
        lstat(fixture.runsRoot, { bigint: true }), lstat(snapshotRoot, { bigint: true }),
        lstat(inputsRoot, { bigint: true }),
      ]);
      expect.soft(exited, "fatal shutdown must exit within six seconds").toBe(true);
      expect.soft(exitElapsedMilliseconds).toBeLessThan(6_000);
      expect.soft(fixture.process.exitCode).toBe(1);
      expect.soft(identity(socketAfter)).toEqual(identity(socketBefore));
      expect.soft(identity(ownerAfter)).toEqual(identity(ownerBefore));
      expect.soft(identity(runsAfter)).toEqual(identity(runsBefore));
      expect.soft(identity(snapshotAfter)).toEqual(identity(snapshotBefore));
      expect.soft(identity(inputsAfter)).toEqual(identity(inputsBefore));
      expect.soft(await readFile(ownerPath, "utf8")).toBe(ownerContent);
      expect.soft(await readdir(fixture.runsRoot)).toEqual(runEntries);
      if (leaseBefore === undefined) {
        await expect(lstat(leasePath)).rejects.toThrow();
      } else {
        expect.soft(identity(await lstat(leasePath, { bigint: true }))).toEqual(identity(leaseBefore));
      }
      if (foreignPath !== undefined) expect(await receive(foreignPath)).toBe("foreign socket alive\n");
    },
    8_000,
  );
});