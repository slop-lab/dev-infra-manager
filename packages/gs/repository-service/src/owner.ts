import { constants } from "node:fs";
import { lstat, open, realpath, statfs, type FileHandle } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, resolve } from "node:path";

const OWNER_VERSION = 1n;
const activeOwners = new Set<string>();
const localFilesystemTypes = new Set([
  0xef53n,
  0x58465342n,
  0x9123683en,
  0x01021994n,
  0x794c7630n,
  0x2fc12fc1n,
  0xf2f52010n,
]);

type FileIdentity = { readonly device: bigint; readonly inode: bigint };

export type StateOwner = {
  readonly createState: boolean;
  release(): void;
};

export async function acquireStateOwner(statePath: string): Promise<StateOwner> {
  const absoluteState = resolve(statePath);
  if (absoluteState !== statePath) throw new RepositoryOwnershipError("repository state path must be absolute and canonical");
  const parent = dirname(absoluteState);
  const parentIdentity = await inspectParent(parent);
  const reservation = `${parentIdentity.device}:${parentIdentity.inode}:${basename(absoluteState)}`;
  if (activeOwners.has(reservation)) throw new RepositoryOwnershipError("repository state already has an active owner");
  activeOwners.add(reservation);
  const ownerPath = `${absoluteState}.owner`;
  let database: DatabaseSync | undefined;
  try {
    const stateExists = await pathExists(absoluteState);
    const opened = await openOwnerFile(ownerPath);
    const ownerIdentity = await inspectOwnerFile(opened.file, ownerPath);
    await opened.file.close();
    database = new DatabaseSync(ownerPath, { defensive: true, readBigInts: true, timeout: 0 });
    await assertOwnerPath(ownerPath, ownerIdentity);
    acquireExclusive(database);
    const version = integerField(database.prepare("PRAGMA user_version").get(), "user_version");
    if (version === 0n) {
      if (!opened.created || stateExists) throw new RepositoryOwnershipError("repository owner state is incomplete or missing");
      initializeOwner(database, parentIdentity, basename(absoluteState));
    } else {
      validateOwner(database, parentIdentity, basename(absoluteState));
      if (!stateExists) throw new RepositoryOwnershipError("owned repository state is missing");
    }
    const activeDatabase = database;
    let active = true;
    return {
      createState: version === 0n,
      release() {
        if (!active) return;
        active = false;
        try {
          activeDatabase.close();
        } finally {
          activeOwners.delete(reservation);
        }
      },
    };
  } catch (error) {
    try {
      database?.close();
    } finally {
      activeOwners.delete(reservation);
    }
    if (isSqliteContention(error)) throw new RepositoryOwnershipError("repository state already has an active owner");
    throw error;
  }
}

async function inspectParent(path: string): Promise<FileIdentity> {
  if (await realpath(path) !== path) throw new RepositoryOwnershipError("repository state parent must be canonical");
  const identity = await lstat(path, { bigint: true });
  const uid = process.getuid?.();
  if (uid === undefined || !identity.isDirectory() || identity.isSymbolicLink()
    || identity.uid !== BigInt(uid) || (identity.mode & 0o022n) !== 0n) {
    throw new RepositoryOwnershipError("repository state parent must be a caller-owned private directory");
  }
  const filesystem = await statfs(path, { bigint: true });
  if (!localFilesystemTypes.has(filesystem.type)) {
    throw new RepositoryOwnershipError("repository state filesystem does not support exclusive ownership locking");
  }
  return { device: identity.dev, inode: identity.ino };
}

async function openOwnerFile(path: string): Promise<{ readonly file: FileHandle; readonly created: boolean }> {
  try {
    return { file: await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600), created: true };
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    try {
      return { file: await open(path, constants.O_RDWR | constants.O_NOFOLLOW), created: false };
    } catch (openError) {
      if (hasCode(openError, "ELOOP")) throw new RepositoryOwnershipError("repository owner database must not be a symbolic link");
      throw openError;
    }
  }
}

async function inspectOwnerFile(file: FileHandle, path: string): Promise<FileIdentity> {
  const identity = await file.stat({ bigint: true });
  const uid = process.getuid?.();
  if (uid === undefined || !identity.isFile() || identity.nlink !== 1n
    || identity.uid !== BigInt(uid) || (identity.mode & 0o777n) !== 0o600n) {
    throw new RepositoryOwnershipError("repository owner database must be a caller-owned mode-0600 regular file");
  }
  const expected = { device: identity.dev, inode: identity.ino };
  await assertOwnerPath(path, expected);
  return expected;
}

async function assertOwnerPath(path: string, expected: FileIdentity): Promise<void> {
  const actual = await lstat(path, { bigint: true });
  if (actual.isSymbolicLink() || !actual.isFile() || actual.dev !== expected.device || actual.ino !== expected.inode) {
    throw new RepositoryOwnershipError("repository owner database changed during startup");
  }
}

function acquireExclusive(database: DatabaseSync): void {
  const mode = database.prepare("PRAGMA journal_mode=DELETE").get();
  if (!isRecord(mode) || mode.journal_mode !== "delete") throw new RepositoryOwnershipError("repository owner requires SQLite DELETE journal mode");
  database.exec("BEGIN EXCLUSIVE");
}

function initializeOwner(database: DatabaseSync, parent: FileIdentity, stateName: string): void {
  database.exec("CREATE TABLE repository_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), parent_device INTEGER NOT NULL, parent_inode INTEGER NOT NULL, state_name TEXT NOT NULL) STRICT; PRAGMA user_version=1");
  database.prepare("INSERT INTO repository_owner VALUES(1,?,?,?)").run(parent.device, parent.inode, stateName);
  database.exec("COMMIT; BEGIN EXCLUSIVE");
  validateOwner(database, parent, stateName);
}

function validateOwner(database: DatabaseSync, parent: FileIdentity, stateName: string): void {
  if (integerField(database.prepare("PRAGMA user_version").get(), "user_version") !== OWNER_VERSION) {
    throw new RepositoryOwnershipError("repository owner database version is unsupported");
  }
  const row = database.prepare("SELECT parent_device,parent_inode,state_name FROM repository_owner WHERE singleton=1").get();
  if (!isRecord(row) || row.parent_device !== parent.device || row.parent_inode !== parent.inode || row.state_name !== stateName) {
    throw new RepositoryOwnershipError("repository owner database belongs to different state");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function integerField(value: unknown, field: string): bigint {
  if (!isRecord(value) || typeof value[field] !== "bigint") throw new RepositoryOwnershipError("repository owner database is invalid");
  return value[field];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isSqliteContention(error: unknown): boolean {
  return error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6);
}

export class RepositoryOwnershipError extends Error {
  readonly name = "RepositoryOwnershipError";
}
