import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { startService } from "./qemuServiceTestSupport.js";
import { publishOwner, socketLeasePath } from "../../.dim/qemu-service-artifacts.mjs";

describe("QEMU structured service ownership", () => {
  it("rejects an invalid record before creating publication artifacts", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-owner-validation-test-"));
    try {
      await expect(publishOwner(resolve(root, "service-owner.json"), { schema: 1 })).rejects.toThrow(
        "invalid service owner record",
      );
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically publishes a mode-0600 schema-2 owner record instead of service.pid", async () => {
    const fixture = await startService("exit");
    const ownerPath = resolve(fixture.root, "service-owner.json");

    const owner: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
    const mode = (await lstat(ownerPath)).mode & 0o7777;
    const [socket, lease] = await Promise.all([
      lstat(fixture.socketPath, { bigint: true }), lstat(socketLeasePath(fixture.socketPath), { bigint: true }),
    ]);
    if (typeof owner !== "object" || owner === null) throw new TypeError("owner record is not an object");
    if (!("socket" in owner) || typeof owner.socket !== "object" || owner.socket === null
      || !("device" in owner.socket) || typeof owner.socket.device !== "string"
      || !("inode" in owner.socket) || typeof owner.socket.inode !== "string") {
      throw new TypeError("owner socket identity is invalid");
    }

    expect.soft(mode).toBe(0o600);
    expect.soft(Number(socket.mode & 0o7777n)).toBe(0o666);
    expect.soft(Number(lease.mode & 0o7777n)).toBe(0o666);
    expect.soft(owner).toMatchObject({ schema: 2, pid: String(fixture.process.pid) });
    expect.soft(Object.keys(owner).sort()).toEqual(["argv", "cwd", "executable", "pid", "pidNamespace", "schema", "socket", "startTicks"]);
    expect.soft(owner.socket).toEqual({ device: socket.dev.toString(), inode: socket.ino.toString() });
    expect.soft(owner.socket).toEqual({ device: lease.dev.toString(), inode: lease.ino.toString() });
    expect.soft({ device: lease.dev, inode: lease.ino }).toEqual({ device: socket.dev, inode: socket.ino });
    await expect(readFile(resolve(fixture.root, "service.pid"), "utf8")).rejects.toThrow();
  });
});
