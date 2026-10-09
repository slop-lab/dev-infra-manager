import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { UserError } from "./errors.js";

const maximumBundleBytes = 256 * 1024 * 1024 - 64 * 1024 - 1;
const maximumRecordBytes = 1024 * 1024;

export type PrivateBundleIdentity = {
  readonly digest: string;
  readonly size: number;
};

export class NativeProjectDraftStoreError extends UserError {
  readonly name = "NativeProjectDraftStoreError";
}

export async function assertPrivateDraftDirectory(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new NativeProjectDraftStoreError("native Project draft directory is missing or inaccessible", { cause: error });
  }
  const owner = process.geteuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || owner === undefined
    || metadata.uid !== owner || (metadata.mode & 0o777) !== 0o700) {
    throw new NativeProjectDraftStoreError("native Project draft directory is not private and owner-only");
  }
}

export async function ensurePrivateDraftDirectory(path: string): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
    await chmod(path, 0o700);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw new NativeProjectDraftStoreError("native Project draft directory cannot be created", { cause: error });
    }
  }
  await assertPrivateDraftDirectory(path);
  if (created) await syncDirectory(dirname(path));
}

export async function inspectPrivateBundle(path: string): Promise<PrivateBundleIdentity> {
  const handle = await openPrivateFile(path, "native Project draft bundle");
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateFile(before, maximumBundleBytes, "native Project draft bundle");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      const { bytesRead } = await handle.read(buffer, 0,
        Math.min(buffer.length, Number(before.size) - position), position);
      if (bytesRead === 0) throw new NativeProjectDraftStoreError("native Project draft bundle is truncated");
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    await assertStablePath(path, before, await handle.stat({ bigint: true }), "native Project draft bundle");
    return { digest: digest.digest("hex"), size: position };
  } finally {
    await handle.close();
  }
}

export async function copyPrivateBundle(
  sourcePath: string,
  artifactDirectory: string
): Promise<PrivateBundleIdentity> {
  await ensurePrivateDraftDirectory(artifactDirectory);
  const temporary = join(artifactDirectory, `.${randomUUID()}.tmp`);
  const source = await openPrivateFile(sourcePath, "native Project draft source bundle");
  let destination;
  try {
    destination = await open(temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    await source.close();
    throw new NativeProjectDraftStoreError("native Project draft bundle staging cannot be created", { cause: error });
  }
  let identity: PrivateBundleIdentity;
  try {
    try {
      const before = await source.stat({ bigint: true });
      assertPrivateFile(before, maximumBundleBytes, "native Project draft source bundle");
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < Number(before.size)) {
        const { bytesRead } = await source.read(buffer, 0,
          Math.min(buffer.length, Number(before.size) - position), position);
        if (bytesRead === 0) throw new NativeProjectDraftStoreError("native Project draft source bundle is truncated");
        await destination.writeFile(buffer.subarray(0, bytesRead));
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      await destination.chmod(0o600);
      await destination.sync();
      await assertStablePath(sourcePath, before, await source.stat({ bigint: true }),
        "native Project draft source bundle");
      identity = { digest: digest.digest("hex"), size: position };
    } finally {
      await Promise.all([source.close(), destination.close()]);
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const target = join(artifactDirectory, `${identity.digest}.bundle`);
  try {
    try {
      await link(temporary, target);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    await unlink(temporary);
    await syncDirectory(artifactDirectory);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new NativeProjectDraftStoreError("native Project draft bundle cannot be published", { cause: error });
  }
  const published = await inspectPrivateBundle(target);
  if (published.digest !== identity.digest || published.size !== identity.size) {
    throw new NativeProjectDraftStoreError("native Project draft bundle conflicts with stored artifact");
  }
  return identity;
}

export async function readPrivateDraftJson(path: string): Promise<unknown | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new NativeProjectDraftStoreError("native Project draft record cannot be opened safely", { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    assertPrivateFile(before, maximumRecordBytes, "native Project draft record");
    const bytes = Buffer.alloc(Number(before.size));
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (bytesRead === 0) throw new NativeProjectDraftStoreError("native Project draft record is truncated");
      position += bytesRead;
    }
    await assertStablePath(path, before, await handle.stat({ bigint: true }), "native Project draft record");
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new NativeProjectDraftStoreError("native Project draft record is not valid JSON", { cause: error });
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

export async function publishPrivateDraft(path: string, value: unknown): Promise<void> {
  const temporary = await writeTemporary(path, value);
  try {
    await link(temporary, path);
    await unlink(temporary);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw new NativeProjectDraftStoreError("native Project draft record cannot be claimed", { cause: error });
  }
}

export async function replacePrivateDraft(path: string, value: unknown): Promise<void> {
  const temporary = await writeTemporary(path, value);
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw new NativeProjectDraftStoreError("native Project draft record cannot be replaced", { cause: error });
  }
}

async function writeTemporary(path: string, value: unknown): Promise<string> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return temporary;
}

async function openPrivateFile(path: string, label: string) {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new NativeProjectDraftStoreError(`${label} cannot be opened safely`, { cause: error });
  }
}

function assertPrivateFile(metadata: BigIntStats, maximumSize: number, label: string): void {
  const owner = process.geteuid?.();
  if (!metadata.isFile() || owner === undefined || metadata.uid !== BigInt(owner)
    || (metadata.mode & 0o777n) !== 0o600n || metadata.nlink !== 1n
    || metadata.size < 1n || metadata.size > BigInt(maximumSize)) {
    throw new NativeProjectDraftStoreError(`${label} is not a bounded private single-link file`);
  }
}

async function assertStablePath(
  path: string,
  before: BigIntStats,
  after: BigIntStats,
  label: string
): Promise<void> {
  let current;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    throw new NativeProjectDraftStoreError(`${label} changed during inspection`, { cause: error });
  }
  if (!sameFile(before, after) || !sameFile(before, current)) {
    throw new NativeProjectDraftStoreError(`${label} changed during inspection`);
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
