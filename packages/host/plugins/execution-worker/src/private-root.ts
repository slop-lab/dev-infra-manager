import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { removeOwnedPrivateRootContents, type NativeHostPrivateRootCleanup } from "./private-root-cleanup.js";

const rootIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const markerName = ".dim-native-ordinary-owner.json";

export type NativeHostPrivateRootIdentity =
  | { readonly schemaVersion: 1; readonly state: "planned"; readonly rootId: string }
  | { readonly schemaVersion: 1; readonly state: "created"; readonly rootId: string;
    readonly device: string; readonly inode: string };

export type NativeHostPrivateRootCreationFaults = {
  readonly beforeStagingMarker?: () => Promise<void>;
  readonly afterPartialStagingMarker?: () => Promise<void>;
  readonly afterStagingMarkerSync?: () => Promise<void>;
};
export type NativeHostPrivateRootCleanupFaults = { readonly beforeStagingRemoval?: () => Promise<void> };

export class NativeHostPrivateRoot {
  readonly path: string;
  readonly stagingPath: string;
  readonly #parent: string;
  #identity: NativeHostPrivateRootIdentity;

  constructor(parent: string, identity: NativeHostPrivateRootIdentity) {
    this.#identity = parseNativeHostPrivateRootIdentity(identity);
    this.#parent = parent;
    this.path = join(parent, `work-${this.#identity.rootId}`);
    this.stagingPath = join(parent, `.work-${this.#identity.rootId}.staging`);
  }

  get identity(): NativeHostPrivateRootIdentity {
    return this.#identity;
  }

  async create(claimId: string, faults: NativeHostPrivateRootCreationFaults = {}): Promise<string> {
    if (this.#identity.state !== "planned") {
      throw new NativeHostPrivateRootError("native ordinary private root was already created");
    }
    const parent = await lstat(this.#parent, { bigint: true });
    if (!isPrivateDirectory(parent)) {
      throw new NativeHostPrivateRootError("native ordinary private root parent ownership or mode is invalid");
    }
    await mkdir(this.stagingPath, { mode: 0o700 });
    await chmod(this.stagingPath, 0o700);
    await faults.beforeStagingMarker?.();
    const markerBytes = JSON.stringify({ schemaVersion: 1, rootId: this.#identity.rootId, claimId });
    const marker = await open(join(this.stagingPath, markerName),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await marker.chmod(0o600);
      const split = Math.ceil(markerBytes.length / 2);
      await marker.writeFile(markerBytes.slice(0, split), "utf8");
      await faults.afterPartialStagingMarker?.();
      await marker.writeFile(markerBytes.slice(split), "utf8");
      await marker.sync();
    } finally {
      await marker.close();
    }
    await syncDirectory(this.stagingPath);
    await faults.afterStagingMarkerSync?.();
    const currentParent = await lstat(this.#parent, { bigint: true });
    if (!sameDirectory(parent, currentParent)) {
      throw new NativeHostPrivateRootError("native ordinary private root parent changed during creation");
    }
    const staged = await lstat(this.stagingPath, { bigint: true });
    if (!isPrivateDirectory(staged) || !await markerMatches(this.stagingPath, this.#identity.rootId, claimId)) {
      throw new NativeHostPrivateRootError("native ordinary private root ownership or mode is invalid");
    }
    if (await pathExists(this.path)) throw new NativeHostPrivateRootError("native ordinary private root already exists");
    await rename(this.stagingPath, this.path);
    await syncDirectory(this.#parent);
    const metadata = await lstat(this.path, { bigint: true });
    const publishedParent = await lstat(this.#parent, { bigint: true });
    if (!sameDirectory(staged, metadata) || !sameDirectory(parent, publishedParent)) {
      throw new NativeHostPrivateRootError("native ordinary private root changed during publication");
    }
    this.#identity = { schemaVersion: 1, state: "created", rootId: this.#identity.rootId,
      device: metadata.dev.toString(), inode: metadata.ino.toString() };
    return this.path;
  }

  async cleanup(claimId: string, cleanup?: NativeHostPrivateRootCleanup, faults: NativeHostPrivateRootCleanupFaults = {}): Promise<boolean> {
    if (cleanup !== undefined && cleanup.grant.executionId !== claimId) return false;
    const parent = await safeLstat(this.#parent);
    if (parent === undefined || !isPrivateDirectory(parent)) return false;
    const stagingExists = await pathExists(this.stagingPath);
    const finalExists = await pathExists(this.path);
    if (stagingExists && finalExists) return false;
    if (stagingExists) return cleanupStaging(this.stagingPath, parent,
      JSON.stringify({ schemaVersion: 1, rootId: this.#identity.rootId, claimId }), this.#identity, faults);
    if (!finalExists) return true;
    const metadata = await safeLstat(this.path);
    if (metadata === undefined) return false;
    if (!isPrivateDirectory(metadata) || !matchesCreatedIdentity(metadata, this.#identity)) return false;
    if (!await markerMatches(this.path, this.#identity.rootId, claimId)) return false;
    const current = await safeLstat(this.path);
    const currentParent = await safeLstat(this.#parent);
    if (current === undefined || currentParent === undefined) return false;
    if (!sameDirectory(metadata, current) || !sameDirectory(parent, currentParent)) return false;
    try {
      try {
        for (const name of await readdir(this.path)) {
          if (name !== markerName) await rm(join(this.path, name), { recursive: true });
        }
      } catch (error) {
        if (!(error instanceof Error) || !["EACCES", "EPERM"].includes(String(Reflect.get(error, "code")))
          || cleanup === undefined || this.#identity.state !== "created") return false;
        const beforeHelper = await safeLstat(this.path), helperParent = await safeLstat(this.#parent);
        if (beforeHelper === undefined || helperParent === undefined || !sameDirectory(metadata, beforeHelper)
          || !sameDirectory(parent, helperParent) || !await markerMatches(this.path, this.#identity.rootId, claimId)) return false;
        if (!await removeOwnedPrivateRootContents({ ...cleanup, path: this.path,
          device: metadata.dev.toString(), inode: metadata.ino.toString(),
          marker: JSON.stringify({ schemaVersion: 1, rootId: this.#identity.rootId, claimId }) })) return false;
      }
      const remaining = await readdir(this.path);
      const after = await safeLstat(this.path), afterParent = await safeLstat(this.#parent);
      if (remaining.length !== 1 || remaining[0] !== markerName || after === undefined || afterParent === undefined
        || !sameDirectory(metadata, after) || !sameDirectory(parent, afterParent)
        || !await markerMatches(this.path, this.#identity.rootId, claimId)) return false;
      await rename(this.path, this.stagingPath);
      await syncDirectory(this.#parent);
      return cleanupStaging(this.stagingPath, parent,
        JSON.stringify({ schemaVersion: 1, rootId: this.#identity.rootId, claimId }), this.#identity, faults);
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  }
}

async function cleanupStaging(path: string, parent: BigIntStats, expectedMarker: string,
  identity: NativeHostPrivateRootIdentity, faults: NativeHostPrivateRootCleanupFaults): Promise<boolean> {
  try {
    const metadata = await lstat(path, { bigint: true });
    if (!isPrivateDirectory(metadata) || !matchesCreatedIdentity(metadata, identity)) return false;
    const entries = await readdir(path);
    if (entries.length > 1 || (entries.length === 1 && entries[0] !== markerName)) return false;
    if (entries.length === 1 && !await removableStagingMarker(path, expectedMarker)) return false;
    const current = await lstat(path, { bigint: true });
    const currentParent = await lstat(dirname(path), { bigint: true });
    if (!sameDirectory(metadata, current) || !sameDirectory(parent, currentParent)) return false;
    if (entries.length === 1) await unlink(join(path, markerName));
    await faults.beforeStagingRemoval?.();
    await rmdir(path);
    await syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

async function removableStagingMarker(path: string, expected: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(join(path, markerName), constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.uid !== serviceUid() || (metadata.mode & 0o777n) !== 0o600n
      || metadata.nlink !== 1n || metadata.size > BigInt(expected.length)) return false;
    const bytes = await handle.readFile("utf8");
    const current = await lstat(join(path, markerName), { bigint: true });
    return expected.startsWith(bytes) && sameDirectory(metadata, current);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

export function plannedNativeHostPrivateRoot(rootId: string): NativeHostPrivateRootIdentity {
  return parseNativeHostPrivateRootIdentity({ schemaVersion: 1, state: "planned", rootId });
}

export function parseNativeHostPrivateRootIdentity(value: unknown): NativeHostPrivateRootIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NativeHostPrivateRootError("native ordinary private root identity is invalid");
  }
  const record = Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
  if (record.schemaVersion !== 1 || typeof record.rootId !== "string" || !rootIdPattern.test(record.rootId)) {
    throw new NativeHostPrivateRootError("native ordinary private root identity is invalid");
  }
  switch (record.state) {
    case "planned":
      requireExactKeys(record, ["schemaVersion", "state", "rootId"]);
      return { schemaVersion: 1, state: "planned", rootId: record.rootId };
    case "created":
      requireExactKeys(record, ["schemaVersion", "state", "rootId", "device", "inode"]);
      if (!isCanonicalInteger(record.device) || !isCanonicalInteger(record.inode)) {
        throw new NativeHostPrivateRootError("native ordinary private root filesystem identity is invalid");
      }
      return {
        schemaVersion: 1,
        state: "created",
        rootId: record.rootId,
        device: record.device,
        inode: record.inode
      };
    default:
      throw new NativeHostPrivateRootError("native ordinary private root state is invalid");
  }
}

async function markerMatches(path: string, rootId: string, claimId: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(join(path, markerName), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.uid !== serviceUid() || (metadata.mode & 0o777n) !== 0o600n
      || metadata.nlink !== 1n || metadata.size < 1n || metadata.size > 1_024n) return false;
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = Object.fromEntries(Object.keys(value).map((key) => [key, Reflect.get(value, key)]));
    return Object.keys(record).length === 3 && record.schemaVersion === 1
      && record.rootId === rootId && record.claimId === claimId;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  } finally {
    await handle.close();
  }
}

function isPrivateDirectory(metadata: BigIntStats): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink()
    && metadata.uid === serviceUid() && (metadata.mode & 0o777n) === 0o700n;
}

function matchesCreatedIdentity(metadata: BigIntStats, identity: NativeHostPrivateRootIdentity): boolean {
  return identity.state === "planned"
    || (metadata.dev.toString() === identity.device && metadata.ino.toString() === identity.inode);
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}

function serviceUid(): bigint {
  const uid = process.geteuid?.();
  if (uid === undefined) throw new NativeHostPrivateRootError("native ordinary host user identity is unavailable");
  return BigInt(uid);
}

function requireExactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  if (Object.keys(record).length !== keys.length || keys.some((key) => record[key] === undefined)) {
    throw new NativeHostPrivateRootError("native ordinary private root identity fields are invalid");
  }
}

function isCanonicalInteger(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function safeLstat(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

export class NativeHostPrivateRootError extends Error {
  readonly name = "NativeHostPrivateRootError";
}
