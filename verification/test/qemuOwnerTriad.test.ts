import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOwnerRecord, inspectOwner, ownerFingerprint } from "../../.dim/qemu-service-owner.mjs";
import {
  captureSocketIdentity, createSocketLease, publishOwner, socketLeasePath,
} from "../../.dim/qemu-service-artifacts.mjs";
import { startService, waitForExit } from "./qemuServiceTestSupport.js";

const ownerScript = resolve(import.meta.dirname, "../../.dim/qemu-service-owner.mjs");
const roots: string[] = [];
const servers: Server[] = [];

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-owner-triad-test-"));
  roots.push(root);
  const ownerPath = resolve(root, "service-owner.json");
  const socketPath = resolve(root, "service.sock");
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  await createSocketLease(socketPath, await captureSocketIdentity(socketPath));
  await publishOwner(ownerPath, await createOwnerRecord(socketPath));
  return { ownerPath, socketPath };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QEMU owner artifact triad", () => {
  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
    [true, true, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ] as const)("classifies owner=%s socket=%s lease=%s", async (hasOwner, hasSocket, hasLease) => {
    const paths = await fixture();
    const leasePath = socketLeasePath(paths.socketPath);
    if (!hasOwner) await rm(paths.ownerPath);
    if (!hasSocket) await rm(paths.socketPath);
    if (!hasLease) await rm(leasePath);
    const presentPaths = [
      hasOwner ? paths.ownerPath : undefined,
      hasSocket ? paths.socketPath : undefined,
      hasLease ? leasePath : undefined,
    ].filter((path) => path !== undefined);
    const before = await Promise.all(presentPaths.map((path) => lstat(path, { bigint: true })));

    if (!hasOwner && !hasSocket && !hasLease) {
      expect(await inspectOwner(paths.ownerPath, paths.socketPath, process.cwd())).toEqual({ state: "absent" });
    } else if (hasOwner && hasSocket && hasLease) {
      const inspected = await inspectOwner(paths.ownerPath, paths.socketPath, process.cwd());
      expect(ownerFingerprint(inspected)).toEqual({
        state: "live",
        pid: String(process.pid),
        startTicks: inspected.record.startTicks,
        owner: inspected.owner,
        socket: inspected.socket,
      });
    } else {
      await expect(inspectOwner(paths.ownerPath, paths.socketPath, process.cwd())).rejects.toThrow("ambiguous");
      const after = await Promise.all(presentPaths.map((path) => lstat(path, { bigint: true })));
      expect(after.map(({ dev, ino }) => ({ dev, ino }))).toEqual(before.map(({ dev, ino }) => ({ dev, ino })));
    }
  });

  it("rejects owner mode drift without changing artifacts", async () => {
    const paths = await fixture();
    await chmod(paths.ownerPath, 0o640);
    await expect(inspectOwner(paths.ownerPath, paths.socketPath, process.cwd())).rejects.toThrow("ambiguous");
    expect(await readFile(paths.ownerPath, "utf8")).toContain('"schema":2');
  });

  it("prints an exact fingerprint and rejects mismatched retire-exact input", async () => {
    const paths = await fixture();
    const inspected = spawnSync(process.execPath, [ownerScript, "inspect", paths.ownerPath, paths.socketPath, process.cwd()], {
      encoding: "utf8",
    });
    const fingerprint: unknown = JSON.parse(inspected.stdout);
    expect.soft(fingerprint).toEqual(ownerFingerprint(await inspectOwner(paths.ownerPath, paths.socketPath, process.cwd())));
    const rejected = spawnSync(process.execPath, [ownerScript, "retire-exact", paths.ownerPath, paths.socketPath,
      process.cwd(), "1", JSON.stringify({})], { encoding: "utf8" });
    expect.soft(rejected.status).not.toBe(0);
    expect.soft(rejected.stderr).toContain("invalid owner fingerprint");
    expect((await lstat(paths.ownerPath)).isFile()).toBe(true);
  });

  it("retires an exact triad after its captured live fingerprint becomes dead", async () => {
    const service = await startService("hold");
    const ownerPath = resolve(service.root, "service-owner.json");
    const live = ownerFingerprint(await inspectOwner(ownerPath, service.socketPath, process.cwd()));
    service.process.kill("SIGKILL");
    expect(await waitForExit(service)).toBe(true);
    expect((await inspectOwner(ownerPath, service.socketPath, process.cwd())).state).toBe("dead");

    const retired = spawnSync(process.execPath, [ownerScript, "retire-exact", ownerPath, service.socketPath,
      process.cwd(), "1", JSON.stringify(live)], { encoding: "utf8" });

    expect.soft(retired.status, retired.stderr).toBe(0);
    await expect(lstat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(service.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(socketLeasePath(service.socketPath))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
