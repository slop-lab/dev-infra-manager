import { errorCode } from "./qemu-values.mts";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseOwnerRecord } from "./qemu-owner-record.mts";

export function identity(stats: Pick<import("node:fs").BigIntStats, "dev" | "ino">) {
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

export function sameIdentity(left: import("./qemu-types.js").ArtifactIdentity, right: import("./qemu-types.js").ArtifactIdentity) {
  return left.device === right.device && left.inode === right.inode;
}

export async function pathState(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function syncContainingDirectory(path: string) {
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function socketLeasePath(socketPath: string) {
  return resolve(dirname(socketPath), `.${basename(socketPath)}.lease`);
}

export async function captureSocketIdentity(socketPath: string) {
  const socketStats = await lstat(socketPath, { bigint: true });
  if (!socketStats.isSocket()) throw new Error("service socket is not a socket");
  return identity(socketStats);
}

export async function createSocketLease(socketPath: string, expected: import("./qemu-types.js").ArtifactIdentity) {
  await link(socketPath, socketLeasePath(socketPath));
  const lease = identity(await lstat(socketLeasePath(socketPath), { bigint: true }));
  if (!sameIdentity(lease, expected)) throw new Error("service socket changed before lease creation");
  await syncContainingDirectory(socketPath);
}

export async function removeIfOwned(path: string, expected: import("./qemu-types.js").ArtifactIdentity) {
  const stats = await pathState(path);
  if (!stats) return true;
  if (!sameIdentity(identity(stats), expected)) return false;
  const quarantined = `${path}.removing-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, quarantined);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
  const moved = identity(await lstat(quarantined, { bigint: true }));
  if (!sameIdentity(moved, expected)) {
    await link(quarantined, path);
    await rm(quarantined);
    await syncContainingDirectory(path);
    return false;
  }
  await rm(quarantined);
  await syncContainingDirectory(path);
  return true;
}

export async function publishOwner(ownerPath: string, record: unknown) {
  parseOwnerRecord(record);
  const temporary = resolve(dirname(ownerPath), `.${basename(ownerPath)}.${process.pid}.${randomUUID()}`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let ownerLinked = false;
  let temporaryIdentity;
  let primaryError;
  try {
    temporaryIdentity = identity(await handle.stat({ bigint: true }));
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.chmod(0o600);
    await handle.sync();
    await link(temporary, ownerPath);
    ownerLinked = true;
    await syncContainingDirectory(ownerPath);
  } catch (error) {
    primaryError = error;
  }
  let temporaryError;
  try {
    if (temporaryIdentity) await removeIfOwned(temporary, temporaryIdentity);
  } catch (error) {
    temporaryError = error;
  }
  let closeError;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  let rollbackError;
  if (ownerLinked && (primaryError || temporaryError || closeError)) {
    try {
      if (temporaryIdentity && !await removeIfOwned(ownerPath, temporaryIdentity)) {
        throw new Error("refusing to roll back replaced service owner");
      }
    } catch (error) {
      rollbackError = error;
    }
  }
  const errors = [primaryError, rollbackError, temporaryError, closeError].filter((error) => error !== undefined);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "service owner publication and rollback failed");
  return temporaryIdentity;
}

export async function requireSocketLease(socketPath: string, expected: import("./qemu-types.js").ArtifactIdentity) {
  const lease = await pathState(socketLeasePath(socketPath));
  if (!lease || !lease.isSocket() || !sameIdentity(identity(lease), expected)) {
    throw new Error("service socket lease mismatch");
  }
}

export async function restoreSocketFromLease(socketPath: string, expected: import("./qemu-types.js").ArtifactIdentity) {
  await requireSocketLease(socketPath, expected);
  await link(socketLeasePath(socketPath), socketPath);
  await syncContainingDirectory(socketPath);
}

export async function removeOwnedArtifacts({ ownerPath, socketPath, owner, socket, preserveSocket = false }: {ownerPath:string, socketPath:string, owner:import("./qemu-types.js").ArtifactIdentity | undefined, socket:import("./qemu-types.js").ArtifactIdentity, preserveSocket?:boolean}) {
  await requireSocketLease(socketPath, socket);
  if (!preserveSocket && !await removeIfOwned(socketPath, socket)) {
    throw new Error("refusing to remove replaced service artifacts");
  }
  if (owner && !await removeIfOwned(ownerPath, owner)) {
    throw new Error("refusing to remove replaced service artifacts");
  }
  await requireSocketLease(socketPath, socket);
  if (!await removeIfOwned(socketLeasePath(socketPath), socket)) {
    throw new Error("refusing to remove replaced service artifacts");
  }
}

export async function safeguardReplacedSocket(socketPath: string, expected: import("./qemu-types.js").ArtifactIdentity) {
  await requireSocketLease(socketPath, expected);
  const current = await pathState(socketPath);
  if (!current) return undefined;
  const actual = identity(current);
  if (sameIdentity(actual, expected)) return undefined;
  const protectedPath = `${socketPath}.replacement.${process.pid}`;
  try {
    await link(socketPath, protectedPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(`refusing to safeguard replaced socket because protected path exists: ${protectedPath}`, { cause: error });
    }
    throw error;
  }
  await syncContainingDirectory(protectedPath);
  if (!await removeIfOwned(socketPath, actual)) {
    throw new Error(`service socket changed while safeguarding replacement; preserved protected socket: ${protectedPath}`);
  }
  return protectedPath;
}

export async function restoreReplacedSocket(protectedPath: string | undefined, socketPath: string) {
  if (!protectedPath) return;
  const expected = identity(await lstat(protectedPath, { bigint: true }));
  try {
    await link(protectedPath, socketPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new Error(`refusing to restore replaced socket because destination exists: ${socketPath}; preserved: ${protectedPath}`, { cause: error });
    }
    throw error;
  }
  await syncContainingDirectory(socketPath);
  if (!await removeIfOwned(protectedPath, expected)) {
    throw new Error(`protected socket changed after restoration: ${protectedPath}`);
  }
}
