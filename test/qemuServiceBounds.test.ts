import { readFile } from "node:fs/promises";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { http, readEvents, startService, waitForExit } from "./qemuServiceTestSupport.js";

const followers: ClientRequest[] = [];

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
      const pid = Number.parseInt(await readFile(path, "utf8"), 10);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      return pid;
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  throw new TypeError("launcher PID was not published");
}

afterEach(() => {
  for (const follower of followers.splice(0)) follower.destroy();
});

describe("QEMU service resource bounds", () => {
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
    await expect(readFile(resolve(fixture.root, "runs"))).rejects.toThrow();
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
});
