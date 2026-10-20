import { errorCode } from "./qemu-values.mts";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

function sameIdentity(left: import("node:fs").BigIntStats, right: import("node:fs").BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function inspectPath(path: string) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function assertServiceDirectory(serviceDirectory: string) {
  let handle;
  try {
    handle = await open(serviceDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const descriptorStat = await handle.stat({ bigint: true });
    const pathStat = await lstat(serviceDirectory, { bigint: true });
    if (!descriptorStat.isDirectory() || !sameIdentity(descriptorStat, pathStat)) {
      throw new Error("QEMU service directory must be a real directory");
    }
    if (descriptorStat.uid !== 0n || descriptorStat.gid !== 0n) {
      throw new Error("QEMU service directory must be owned by root:root");
    }
    if ((descriptorStat.mode & 0o7777n) !== 0o755n) {
      throw new Error("QEMU service directory must have mode 0755");
    }
  } finally {
    await handle?.close();
  }
}

export async function prepareServiceFilesystem(paths: import("./qemu-types.js").ServicePaths) {
  await assertServiceDirectory(paths.serviceDirectory);
  for (const path of [paths.pidPath, paths.ownerPath, paths.socketPath, paths.leasePath]) {
    if (await inspectPath(path)) throw new Error(`QEMU service path already exists: ${path}`);
  }
  const preparedRunsRoot = `${paths.runsRoot}.prepared-${process.pid}-${randomUUID()}`;
  await mkdir(preparedRunsRoot, { mode: 0o700 });
  return preparedRunsRoot;
}

export async function activatePreparedRuns(runsRoot: string, preparedRunsRoot: string, operations: {rename: typeof rename, rm: typeof rm} = { rename, rm }) {
  const replacedRunsRoot = `${runsRoot}.replaced-${process.pid}-${randomUUID()}`;
  let replaced = false;
  try {
    try {
      await operations.rename(runsRoot, replacedRunsRoot);
      replaced = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await operations.rename(preparedRunsRoot, runsRoot);
  } catch (error) {
    if (replaced) {
      try {
        await operations.rename(replacedRunsRoot, runsRoot);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "QEMU runs activation and rollback failed");
      }
    }
    throw error;
  }
  if (replaced) await operations.rm(replacedRunsRoot, { recursive: true });
}

export async function discardPreparedRuns(preparedRunsRoot: string) {
  await rm(preparedRunsRoot, { recursive: true, force: true });
}
