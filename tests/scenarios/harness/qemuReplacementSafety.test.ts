import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { http, readEvents, startService, waitForObservation } from "./qemuServiceTestSupport.js";

const serviceScript = resolve(import.meta.dirname, "../qemu/qemu-service.mts");
const roots: string[] = [];
const processes: ChildProcess[] = [];
afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("standalone QEMU service replacement ownership", () => {
  it("refuses a second direct service without replacing the active socket or run tree", async () => {
    const fixture = await startService("hold");
    const started = await http(fixture, { body: { inputs: [], mode: "run" }, method: "POST", path: "/v1/run" });
    await readEvents(fixture, "ready\n");
    const runNames = await readdir(fixture.runsRoot);
    const socketIdentity = await lstat(fixture.socketPath, { bigint: true });
    const second = spawn(process.execPath, [serviceScript], {
      env: {
        ...process.env,
        DIM_QEMU_LAUNCHER: "/bin/false",
        DIM_QEMU_SERVICE_SOCKET: fixture.socketPath,
        DIM_QEMU_SOURCE_ROOT: fixture.sourceRoot
      },
      stdio: "ignore"
    });
    processes.push(second);

    const outcome = await Promise.race([
      new Promise<"exited">((resolveExit) => second.once("exit", () => resolveExit("exited"))),
      waitForObservation(async () => {
        const recorded = JSON.parse(await readFile(resolve(fixture.root, "service-owner.json"), "utf8")) as { pid: string };
        return Number(recorded.pid) !== fixture.process.pid ? "replaced" as const : undefined;
      }, 1_000)
    ]);
    const status = await http(fixture, { method: "GET", path: "/v1/status" });

    expect.soft(started.status).toBe(202);
    expect.soft(outcome).toBe("exited");
    expect.soft(status.body).toContain('"status":"running"');
    expect.soft((await lstat(fixture.socketPath, { bigint: true })).ino).toBe(socketIdentity.ino);
    expect(await readdir(fixture.runsRoot)).toEqual(runNames);
  });

  it("rejects a pre-existing deterministic lease without replacing it", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-foreign-lease-"));
    roots.push(root);
    const fixture = { root, serviceDirectory: resolve(root, "service") };
    await mkdir(fixture.serviceDirectory);
    const leasePath = resolve(fixture.serviceDirectory, ".service.sock.lease");
    await writeFile(leasePath, "foreign lease\n");

    const service = spawn(process.execPath, [serviceScript], {
      env: { ...process.env, DIM_QEMU_LAUNCHER: "/bin/false",
        DIM_QEMU_SERVICE_SOCKET: resolve(fixture.serviceDirectory, "service.sock"),
        DIM_QEMU_SOURCE_ROOT: fixture.root },
      stdio: "ignore",
    });
    processes.push(service);
    await new Promise<void>((resolveExit) => service.once("exit", () => resolveExit()));

    expect.soft(service.exitCode).not.toBe(0);
    expect.soft(await readFile(leasePath, "utf8")).toBe("foreign lease\n");
    await expect(lstat(resolve(fixture.serviceDirectory, "service.sock"))).rejects.toThrow();
  });
});