import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { link, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOwnerRecord, inspectOwner, parseOwnerRecord, retireOwner,
} from "../../.dim/qemu-service-owner.mjs";
import {
  captureSocketIdentity, createSocketLease, publishOwner, removeOwnedArtifacts,
  restoreReplacedSocket, safeguardReplacedSocket, socketLeasePath,
} from "../../.dim/qemu-service-artifacts.mjs";

const ownerScript = resolve(import.meta.dirname, "../../.dim/qemu-service-owner.mjs");

const roots: string[] = [];
const servers: Server[] = [];

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-owner-test-"));
  roots.push(root);
  const socketPath = resolve(root, "service.sock");
  const ownerPath = resolve(root, "service-owner.json");
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  await createSocketLease(socketPath, await captureSocketIdentity(socketPath));
  return { ownerPath, root, server, socketPath };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("QEMU owner record contract", () => {
  it("rejects trailing CLI arguments and invalid retirement timeouts before filesystem access", async () => {
    const { ownerPath, socketPath } = await fixture();
    const record = await createOwnerRecord(socketPath);
    await publishOwner(ownerPath, record);

    const trailing = spawnSync(process.execPath, [ownerScript, "inspect", ownerPath, socketPath, process.cwd(), record.pid, "extra"]);
    const invalidTimeoutStatuses = ["NaN", "Infinity", "-1", "1.5", "9007199254740992"].map((timeout) =>
      spawnSync(process.execPath, [ownerScript, "retire", resolve(tmpdir(), "absent-owner"),
        resolve(tmpdir(), "absent-socket"), process.cwd(), timeout]).status);

    expect.soft(trailing.status).not.toBe(0);
    expect(invalidTimeoutStatuses.every((status) => status !== 0)).toBe(true);
  });

  it("rejects partial, extra-key, non-decimal, and non-canonical records", async () => {
    const { socketPath } = await fixture();
    const valid = await createOwnerRecord(socketPath);

    expect.soft(() => parseOwnerRecord({ ...valid, schema: undefined })).toThrow();
    expect.soft(() => parseOwnerRecord({ ...valid, extra: true })).toThrow();
    expect.soft(() => parseOwnerRecord({ ...valid, pid: 12 })).toThrow();
    expect(() => parseOwnerRecord({ ...valid, executable: { ...valid.executable, path: "/tmp/../bin/node" } })).toThrow();
  });

  it("rejects unsafe and kernel-out-of-range PID strings", async () => {
    const { socketPath } = await fixture();
    const valid = await createOwnerRecord(socketPath);
    const pidMax = BigInt((await readFile("/proc/sys/kernel/pid_max", "utf8")).trim());

    expect.soft(() => parseOwnerRecord({ ...valid, pid: "9007199254740992" })).toThrow();
    expect(() => parseOwnerRecord({ ...valid, pid: (pidMax + 1n).toString() })).toThrow();
  });

  it("rejects argv spoofing without signalling or removing live artifacts", async () => {
    const { ownerPath, socketPath } = await fixture();
    const record = await createOwnerRecord(socketPath);
    await publishOwner(ownerPath, { ...record, argv: [...record.argv, "spoofed"] });

    await expect(inspectOwner(ownerPath, socketPath, process.cwd())).rejects.toThrow("process identity mismatch");
    expect.soft((await lstat(socketPath)).isSocket()).toBe(true);
    expect((await lstat(ownerPath)).isFile()).toBe(true);
  });

  it("classifies structurally exact dead residue and removes only its captured inodes", async () => {
    const { ownerPath, socketPath } = await fixture();
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const record = { ...await createOwnerRecord(socketPath), pid: String(exited.pid) };
    await publishOwner(ownerPath, record);

    expect.soft((await inspectOwner(ownerPath, socketPath, process.cwd())).state).toBe("dead");
    await retireOwner(ownerPath, socketPath, process.cwd(), 1);

    await expect(readFile(ownerPath)).rejects.toThrow();
    await expect(lstat(socketPath)).rejects.toThrow();
    await expect(lstat(socketLeasePath(socketPath))).rejects.toThrow();
  });

  it("preserves replaced owner and socket inodes during cleanup", async () => {
    const first = await fixture();
    const record = await createOwnerRecord(first.socketPath);
    const owner = await publishOwner(first.ownerPath, record);
    const leaseIdentity = await lstat(socketLeasePath(first.socketPath), { bigint: true });
    await new Promise<void>((resolveClose) => first.server.close(() => resolveClose()));
    const replacementOwner = resolve(first.root, "replacement-owner.json");
    await writeFile(replacementOwner, "replacement-owner\n");
    await rename(replacementOwner, first.ownerPath);
    const replacement = createServer();
    servers.push(replacement);
    const foreignPath = resolve(first.root, "foreign.sock");
    await new Promise<void>((resolveListen) => replacement.listen(foreignPath, resolveListen));
    await link(foreignPath, first.socketPath);
    const replacementIdentity = await lstat(first.socketPath, { bigint: true });

    expect.soft({ device: replacementIdentity.dev, inode: replacementIdentity.ino })
      .not.toEqual({ device: leaseIdentity.dev, inode: leaseIdentity.ino });
    await expect(removeOwnedArtifacts({ owner, ownerPath: first.ownerPath, socket: record.socket,
      socketPath: first.socketPath })).rejects.toThrow("replaced");
    expect.soft((await lstat(first.socketPath)).isSocket()).toBe(true);
    expect(await readFile(first.ownerPath, "utf8")).toBe("replacement-owner\n");
  });

  it("keeps an unlinked listener inode distinct from a successor bound at the same path", async () => {
    const original = await fixture();
    const originalIdentity = await lstat(original.socketPath, { bigint: true });
    await rm(original.socketPath);
    const successor = createServer();
    servers.push(successor);
    await new Promise<void>((resolveListen, rejectListen) => {
      successor.once("error", rejectListen);
      successor.listen(original.socketPath, resolveListen);
    });
    const successorIdentity = await lstat(original.socketPath, { bigint: true });

    expect(original.server.listening).toBe(true);
    expect({ dev: successorIdentity.dev, ino: successorIdentity.ino })
      .not.toEqual({ dev: originalIdentity.dev, ino: originalIdentity.ino });
  });

  it("preserves both foreign sockets when restoration finds a second replacement", async () => {
    const { root, socketPath } = await fixture();
    const expected = await captureSocketIdentity(socketPath);
    await rm(socketPath);
    const foreignA = createServer();
    servers.push(foreignA);
    const foreignAPath = resolve(root, "foreign-a.sock");
    await new Promise<void>((resolveListen) => foreignA.listen(foreignAPath, resolveListen));
    await link(foreignAPath, socketPath);
    const protectedPath = await safeguardReplacedSocket(socketPath, expected);
    if (protectedPath === undefined) throw new TypeError("foreign A was not safeguarded");
    const protectedIdentity = await lstat(protectedPath, { bigint: true });
    const foreignB = createServer();
    servers.push(foreignB);
    const foreignBPath = resolve(root, "foreign-b.sock");
    await new Promise<void>((resolveListen) => foreignB.listen(foreignBPath, resolveListen));
    await link(foreignBPath, socketPath);
    const foreignBIdentity = await lstat(socketPath, { bigint: true });

    const restoration = await Promise.allSettled([restoreReplacedSocket(protectedPath, socketPath)]);
    const survivingSocket = await lstat(socketPath, { bigint: true });
    const survivingProtected = await Promise.allSettled([lstat(protectedPath, { bigint: true })]);

    expect.soft(restoration).toMatchObject([{ status: "rejected", reason: expect.objectContaining({
      message: expect.stringContaining(`destination exists: ${socketPath}; preserved: ${protectedPath}`),
    }) }]);
    expect.soft({ device: survivingSocket.dev, inode: survivingSocket.ino })
      .toEqual({ device: foreignBIdentity.dev, inode: foreignBIdentity.ino });
    expect(survivingProtected).toMatchObject([{ status: "fulfilled", value: {
      dev: protectedIdentity.dev, ino: protectedIdentity.ino,
    } }]);
  });

  it("rejects owner-only state as ambiguous", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-owner-only-test-"));
    roots.push(root);
    const ownerPath = resolve(root, "service-owner.json");
    await writeFile(ownerPath, "{}\n");

    await expect(inspectOwner(ownerPath, resolve(root, "service.sock"), root)).rejects.toThrow("ambiguous");
    expect(await readFile(ownerPath, "utf8")).toBe("{}\n");
  });
});