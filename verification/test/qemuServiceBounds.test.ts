import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { http, readEvents, startService, waitForExit } from "./qemuServiceTestSupport.js";
import { socketLeasePath } from "../../.dim/qemu-service-artifacts.mjs";

const followers: ClientRequest[] = [];

async function evidenceIdentity(fixture: Awaited<ReturnType<typeof startService>>) {
  const ownerPath = resolve(fixture.root, "service-owner.json");
  const [owner, socket, lease] = await Promise.all([
    lstat(ownerPath, { bigint: true }), lstat(fixture.socketPath, { bigint: true }),
    lstat(socketLeasePath(fixture.socketPath), { bigint: true }),
  ]);
  const record: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
  if (typeof record !== "object" || record === null || !("socket" in record)) throw new TypeError("owner socket identity is missing");
  return { lease, owner, recordSocket: record.socket, socket };
}

function expectSameEvidence(before: Awaited<ReturnType<typeof evidenceIdentity>>, after: Awaited<ReturnType<typeof evidenceIdentity>>) {
  expect.soft({ dev: after.owner.dev, ino: after.owner.ino }).toEqual({ dev: before.owner.dev, ino: before.owner.ino });
  expect.soft({ dev: after.socket.dev, ino: after.socket.ino }).toEqual({ dev: before.socket.dev, ino: before.socket.ino });
  expect.soft({ dev: after.lease.dev, ino: after.lease.ino }).toEqual({ dev: before.lease.dev, ino: before.lease.ino });
  expect.soft(after.recordSocket).toEqual({ device: before.socket.dev.toString(), inode: before.socket.ino.toString() });
}

function openFollower(socketPath: string): Promise<IncomingMessage> {
  return new Promise((resolveResponse, rejectResponse) => {
    const outgoing = request({ socketPath, method: "GET", path: "/v1/events" });
    followers.push(outgoing);
    outgoing.once("response", resolveResponse);
    outgoing.once("error", rejectResponse);
    outgoing.end();
  });
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

async function launcherPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const value = await readFile(path, "utf8");
      if (/^[1-9][0-9]*\n?$/.test(value)) {
        const pid = Number(value);
        if (Number.isSafeInteger(pid)) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
          return pid;
        }
      }
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new TypeError("launcher PID was not published");
}

afterEach(() => {
  for (const follower of followers.splice(0)) follower.destroy();
});

describe("QEMU service resource bounds", () => {
  it("rejects an incomplete launcher PID instead of treating it as a process group", async () => {
    // Given: shell redirection has created the PID file but has not written its contents.
    const root = await mkdtemp(resolve(tmpdir(), "dim-incomplete-launcher-pid-"));
    try {
      const path = resolve(root, "launcher.pid");
      await writeFile(path, "");

      // When / Then: an incomplete publication cannot become a PID.
      await expect(launcherPid(path)).rejects.toThrow("launcher PID was not published");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects follower 17 before headers and admits another after one closes", async () => {
    const fixture = await startService("hold");
    await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture, "ready\n");
    const admitted = await Promise.all(Array.from({ length: 16 }, () => openFollower(fixture.socketPath)));

    const rejected = await openFollower(fixture.socketPath);
    admitted[0]?.destroy();
    const replacement = await openFollower(fixture.socketPath);

    expect.soft(admitted.every((response) => response.statusCode === 200)).toBe(true);
    expect.soft(rejected.statusCode).toBe(503);
    expect(replacement.statusCode).toBe(200);
  });

  it("destroys a follower immediately when replay write reports backpressure", async () => {
    const fixture = await startService("hold", { forceResponseBackpressure: true });
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    expect(started, started.body).toMatchObject({ status: 202 });
    await launcherPid(fixture.launcherPidFile);

    const closed = await openFollower(fixture.socketPath).then(
      (follower) => new Promise<boolean>((resolveClose) => {
        follower.once("close", () => resolveClose(true));
        setTimeout(() => resolveClose(false), 500);
      }),
      (error: NodeJS.ErrnoException) => error.code === "ECONNRESET",
    );

    expect(closed).toBe(true);
  });

  it("escalates a TERM-ignoring launcher group on cancel before cleanup", async () => {
    const fixture = await startService("hold", { ignoreLauncherTerm: true });
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    expect(started, started.body).toMatchObject({ status: 202 });
    const leader = await launcherPid(fixture.launcherPidFile);

    const cancelled = await http(fixture, { method: "DELETE", path: "/v1/run" });

    expect.soft(cancelled.status).toBe(202);
    expect.soft(groupIsGone(leader)).toBe(true);
    expect(await readdir(resolve(fixture.root, "runs"))).toEqual([]);
  }, 7_000);

  it("escalates a TERM-ignoring launcher group before service shutdown cleanup", async () => {
    const fixture = await startService("hold", { ignoreLauncherTerm: true });
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    expect(started, started.body).toMatchObject({ status: 202 });
    const leader = await launcherPid(fixture.launcherPidFile);

    fixture.process.kill("SIGTERM");
    const exited = await waitForExit(fixture, 6_000);

    expect.soft(exited).toBe(true);
    expect(groupIsGone(leader)).toBe(true);
  }, 7_000);

  it("finalizes the process group when the leader exits before its descendant", async () => {
    const fixture = await startService("hold", { leaderExits: true });
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    expect(started, started.body).toMatchObject({ status: 202 });
    const leader = await launcherPid(fixture.launcherPidFile);
    const descendant = await launcherPid(fixture.descendantPidFile);

    const events = await readEvents(fixture);

    expect.soft(events).toContain("ready\n");
    expect.soft(groupIsGone(leader)).toBe(true);
    expect.soft(groupIsGone(descendant)).toBe(true);
    expect(await readdir(fixture.runsRoot)).toEqual([]);
  });

  it("fails shutdown without deleting evidence when a process group remains live after SIGKILL", async () => {
    const fixture = await startService("hold", { residualProcessGroup: true });
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    expect(started, started.body).toMatchObject({ status: 202 });
    await readEvents(fixture, "ready\n");
    const before = await evidenceIdentity(fixture);

    fixture.process.kill("SIGTERM");
    const exited = await waitForExit(fixture, 6_000);

    expect.soft(exited).toBe(true);
    expect.soft(fixture.process.exitCode).toBe(1);
    expectSameEvidence(before, await evidenceIdentity(fixture));
    await expect(lstat(resolve(fixture.root, "service-owner.json"))).resolves.toBeDefined();
    await expect(lstat(fixture.socketPath)).resolves.toBeDefined();
    expect(await readdir(fixture.runsRoot)).toHaveLength(1);
  }, 7_000);

  it("exits fatally and preserves evidence when spontaneous finalization leaves a live process group", async () => {
    const fixture = await startService("hold", { leaderExits: true, residualProcessGroup: true });
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    expect(started, started.body).toMatchObject({ status: 202 });
    await launcherPid(fixture.descendantPidFile);
    const before = await evidenceIdentity(fixture);

    const exited = await waitForExit(fixture, 6_000);

    expect.soft(exited).toBe(true);
    expect.soft(fixture.process.exitCode).toBe(1);
    expectSameEvidence(before, await evidenceIdentity(fixture));
    await expect(lstat(resolve(fixture.root, "service-owner.json"))).resolves.toBeDefined();
    await expect(lstat(fixture.socketPath)).resolves.toBeDefined();
    await expect(lstat(socketLeasePath(fixture.socketPath))).resolves.toBeDefined();
    expect(await readdir(fixture.runsRoot)).toHaveLength(1);
  }, 7_000);

  it("coalesces concurrent cancel and repeated signals during fatal spontaneous finalization", async () => {
    const fixture = await startService("hold", { leaderExits: true, residualProcessGroup: true });
    await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await launcherPid(fixture.descendantPidFile);
    const before = await evidenceIdentity(fixture);

    const cancellation = http(fixture, { method: "DELETE", path: "/v1/run" }).catch(() => undefined);
    fixture.process.kill("SIGTERM");
    fixture.process.kill("SIGTERM");
    const [exited] = await Promise.all([waitForExit(fixture, 6_000), cancellation]);

    expect.soft(exited).toBe(true);
    expect.soft(fixture.process.exitCode).toBe(1);
    expectSameEvidence(before, await evidenceIdentity(fixture));
    await expect(lstat(resolve(fixture.root, "service-owner.json"))).resolves.toBeDefined();
    expect(await readdir(fixture.runsRoot)).toHaveLength(1);
  }, 7_000);
});