import { constants } from "node:fs";
import { lstat, open, realpath, statfs, type FileHandle } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const OWNER_DATABASE = ".dim-native-git-owner.sqlite3";
const OWNER_SCHEMA_VERSION = 1n;
const LOCAL_FILESYSTEM_TYPES = new Set([
  0xef53n,
  0x58465342n,
  0x9123683en,
  0x01021994n,
  0x794c7630n,
  0x2fc12fc1n,
  0xf2f52010n
]);
const activeStorageRoots = new Set<string>();

export type StorageOwner = {
  release(): Promise<void>;
};

export async function acquireStorageOwner(storageRoot: string): Promise<StorageOwner> {
  const root = resolve(storageRoot);
  const rootIdentity = await inspectStorageRoot(storageRoot, root);
  const reservation = reserveStorageRoot(rootIdentity);
  const databasePath = join(root, OWNER_DATABASE);
  let database: DatabaseSync | undefined;
  try {
    const fileIdentity = await inspectOwnerFileAtPath(databasePath);
    database = new DatabaseSync(databasePath, { defensive: true, readBigInts: true, timeout: 0 });
    await assertUnchangedOwnerFile(databasePath, fileIdentity);
    acquireExclusiveTransaction(database);
    initializeOrValidate(database, rootIdentity);
  } catch (error) {
    try {
      database?.close();
    } finally {
      activeStorageRoots.delete(reservation);
    }
    if (isSqliteLockContention(error)) {
      throw new StorageOwnershipError("storage root already has an active server");
    }
    throw error;
  }

  let active = true;
  return {
    async release() {
      if (!active) return;
      active = false;
      try {
        database.close();
      } finally {
        activeStorageRoots.delete(reservation);
      }
    }
  };
}

export async function inspectStorageOwner(storageRoot: string): Promise<void> {
  const root = resolve(storageRoot);
  const rootIdentity = await inspectStorageRoot(storageRoot, root);
  const databasePath = join(root, OWNER_DATABASE);
  const fileIdentity = await inspectExistingOwnerFile(databasePath);
  const databaseUrl = pathToFileURL(databasePath);
  databaseUrl.searchParams.set("immutable", "1");
  const database = new DatabaseSync(databaseUrl, { readOnly: true, readBigInts: true });
  try {
    await assertUnchangedOwnerFile(databasePath, fileIdentity);
    validateOwnerDatabase(database, rootIdentity);
  } finally {
    database.close();
  }
}

type RootIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
};

function reserveStorageRoot(root: RootIdentity): string {
  const key = `${root.device}:${root.inode}`;
  if (activeStorageRoots.has(key)) {
    throw new StorageOwnershipError("storage root already has an active server");
  }
  activeStorageRoots.add(key);
  return key;
}

async function inspectStorageRoot(configuredRoot: string, root: string): Promise<RootIdentity> {
  if (configuredRoot !== root || await realpath(root) !== root) {
    throw new StorageOwnershipError("storage root must be a canonical non-symbolic-link path");
  }
  const identity = await lstat(root, { bigint: true });
  const uid = process.getuid?.();
  if (uid === undefined || !identity.isDirectory() || identity.isSymbolicLink()
    || identity.uid !== BigInt(uid) || (identity.mode & 0o022n) !== 0n) {
    throw new StorageOwnershipError("storage root must be a caller-owned non-writable-by-others directory");
  }
  const filesystem = await statfs(root, { bigint: true });
  if (!LOCAL_FILESYSTEM_TYPES.has(filesystem.type)) {
    throw new StorageOwnershipError(`storage root filesystem type 0x${filesystem.type.toString(16)} does not support ownership locking`);
  }
  return { device: identity.dev, inode: identity.ino };
}

async function openOwnerFile(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    try {
      return await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (openError) {
      if (isCode(openError, "ELOOP")) {
        throw new StorageOwnershipError("storage owner database must not be a symbolic link");
      }
      throw openError;
    }
  }
}

async function inspectOwnerFileAtPath(path: string): Promise<RootIdentity> {
  const file = await openOwnerFile(path);
  try {
    return await inspectOwnerFile(file, path);
  } finally {
    await file.close();
  }
}

async function inspectExistingOwnerFile(path: string): Promise<RootIdentity> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isCode(error, "ELOOP")) {
      throw new StorageOwnershipError("storage owner database must not be a symbolic link");
    }
    throw error;
  }
  try {
    return await inspectOwnerFile(file, path);
  } finally {
    await file.close();
  }
}

async function inspectOwnerFile(file: FileHandle, path: string): Promise<RootIdentity> {
  const identity = await file.stat({ bigint: true });
  if (!identity.isFile() || identity.nlink !== 1n || identity.uid !== BigInt(process.getuid?.() ?? -1)
    || (identity.mode & 0o777n) !== 0o600n) {
    throw new StorageOwnershipError("storage owner database must be a caller-owned mode-0600 regular file with one link");
  }
  await assertUnchangedOwnerFile(path, { device: identity.dev, inode: identity.ino });
  return { device: identity.dev, inode: identity.ino };
}

async function assertUnchangedOwnerFile(path: string, expected: RootIdentity): Promise<void> {
  const actual = await lstat(path, { bigint: true });
  if (actual.isSymbolicLink() || !actual.isFile() || actual.dev !== expected.device || actual.ino !== expected.inode) {
    throw new StorageOwnershipError("storage owner database changed during startup");
  }
}

function acquireExclusiveTransaction(database: DatabaseSync): void {
  const journalMode = database.prepare("PRAGMA journal_mode = DELETE").get();
  if (!isRecord(journalMode) || journalMode.journal_mode !== "delete") {
    throw new StorageOwnershipError("storage owner database requires SQLite DELETE journal mode");
  }
  database.exec("BEGIN EXCLUSIVE");
}

function initializeOrValidate(database: DatabaseSync, root: RootIdentity): void {
  const version = integerField(database.prepare("PRAGMA user_version").get(), "user_version");
  if (version === 0n) {
    const schemaEntries = integerField(
      database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get(),
      "count"
    );
    if (schemaEntries !== 0n) throw new StorageOwnershipError("storage owner database schema is unsupported");
    database.exec(`
      CREATE TABLE storage_owner_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        root_device INTEGER NOT NULL,
        root_inode INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    database.prepare(
      "INSERT INTO storage_owner_identity (singleton, root_device, root_inode) VALUES (1, ?, ?)"
    ).run(root.device, root.inode);
    database.exec("COMMIT");
    database.exec("BEGIN EXCLUSIVE");
  } else if (version !== OWNER_SCHEMA_VERSION) {
    throw new StorageOwnershipError("storage owner database schema is unsupported");
  }

  validateOwnerDatabase(database, root);
}

function validateOwnerDatabase(database: DatabaseSync, root: RootIdentity): void {
  const version = integerField(database.prepare("PRAGMA user_version").get(), "user_version");
  if (version !== OWNER_SCHEMA_VERSION) {
    throw new StorageOwnershipError("storage owner database schema is unsupported");
  }
  const entries = integerField(
    database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get(),
    "count"
  );
  if (entries !== 1n) throw new StorageOwnershipError("storage owner database schema is unsupported");
  const identity = database.prepare(
    "SELECT root_device, root_inode FROM storage_owner_identity WHERE singleton = 1"
  ).get();
  if (!isRecord(identity) || identity.root_device !== root.device || identity.root_inode !== root.inode) {
    throw new StorageOwnershipError("storage owner database belongs to a different storage root");
  }
}

function integerField(value: unknown, field: string): bigint {
  if (!isRecord(value) || typeof value[field] !== "bigint") {
    throw new StorageOwnershipError("storage owner database schema is unsupported");
  }
  return value[field];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSqliteLockContention(error: unknown): boolean {
  return error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class StorageOwnershipError extends Error {
  readonly name = "StorageOwnershipError";
}
