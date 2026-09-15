import { link, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOwnerRecord, inspectOwner,
} from "../../project/.dim/qemu-service-owner.mjs";
import {
  captureSocketIdentity, createSocketLease, publishOwner, removeOwnedArtifacts,
  safeguardReplacedSocket, socketLeasePath,
} from "../../project/.dim/qemu-service-artifacts.mjs";

const roots: string[] = [];
const servers: Server[] = [];

async function fixture(createLease = true) {
  const root = await mkdtemp(resolve(tmpdir(), "dim-qemu-lease-test-"));
  roots.push(root);
  const socketPath = resolve(root, "service.sock");
  const ownerPath = resolve(root, "service-owner.json");
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  if (createLease) await createSocketLease(socketPath, await captureSocketIdentity(socketPath));
  return { ownerPath, root, socketPath };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => {
    if (!server.listening) return resolveClose();
    server.close(() => resolveClose());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("QEMU socket inode lease", () => {
  it("uses the exact adjacent path and hard-links the owned socket inode", async () => {
    const { root, socketPath } = await fixture(false);

    await createSocketLease(socketPath, await captureSocketIdentity(socketPath));

    const leasePath = resolve(root, ".service.sock.lease");
    const [socket, lease] = await Promise.all([
      lstat(socketPath, { bigint: true }), lstat(leasePath, { bigint: true }),
    ]);
    expect.soft(socketLeasePath(socketPath)).toBe(leasePath);
    expect({ device: lease.dev, inode: lease.ino }).toEqual({ device: socket.dev, inode: socket.ino });
  });

  it("keeps schema 1 exact while requiring the public socket and lease to match", async () => {
    const { ownerPath, socketPath } = await fixture();

    const record = await createOwnerRecord(socketPath);
    await publishOwner(ownerPath, record);

    expect.soft(Object.keys(record).sort()).toEqual(["argv", "cwd", "executable", "pid", "schema", "socket", "startTicks"]);
    expect.soft(Object.keys(record.socket).sort()).toEqual(["device", "inode"]);
    await rm(socketLeasePath(socketPath));
    await expect(inspectOwner(ownerPath, socketPath, process.cwd())).rejects.toThrow("ambiguous");
  });

  it("preserves a colliding lease without replacing it", async () => {
    const { socketPath } = await fixture(false);
    const leasePath = socketLeasePath(socketPath);
    await writeFile(leasePath, "foreign lease\n");

    await expect(createSocketLease(socketPath, await captureSocketIdentity(socketPath))).rejects.toThrow();

    expect.soft(await readFile(leasePath, "utf8")).toBe("foreign lease\n");
    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });

  it("rejects a mismatched lease before owner creation or socket safeguarding", async () => {
    const owned = await fixture(false);
    const foreign = await fixture();
    await link(foreign.socketPath, socketLeasePath(owned.socketPath));
    const expected = await lstat(owned.socketPath, { bigint: true });
    const identity = { device: expected.dev.toString(), inode: expected.ino.toString() };

    await expect(createOwnerRecord(owned.socketPath)).rejects.toThrow("lease");
    await expect(safeguardReplacedSocket(owned.socketPath, identity)).rejects.toThrow("lease");
  });

  it("fails closed before cleanup when the lease is missing", async () => {
    const { ownerPath, socketPath } = await fixture();
    const record = await createOwnerRecord(socketPath);
    const owner = await publishOwner(ownerPath, record);
    await rm(socketLeasePath(socketPath));

    await expect(removeOwnedArtifacts({ owner, ownerPath, socket: record.socket, socketPath })).rejects.toThrow("lease");

    expect.soft((await lstat(ownerPath)).isFile()).toBe(true);
    expect((await lstat(socketPath)).isSocket()).toBe(true);
  });
});
