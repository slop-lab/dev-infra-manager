import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import { acquireStorageOwner, inspectStorageOwner, type StorageOwner } from "./storage-owner.js";

const ownerDatabaseName = ".dim-native-git-owner.sqlite3";
const databaseName = "native-idle.sqlite3";
const markerName = "state-format.json";
const activationSchema = `CREATE TABLE bundle_activation (
  generation_id TEXT PRIMARY KEY CHECK (length(generation_id) = 64 AND generation_id NOT GLOB '*[^0-9a-f]*'),
  activation_token_sha256 TEXT NOT NULL UNIQUE
    CHECK (length(activation_token_sha256) = 64 AND activation_token_sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT`;
const allowedEntries = new Set([ownerDatabaseName, databaseName, markerName]);

export type NativeGitBundleState = {
  readonly database: string;
  readonly stateFormat: 3;
  readonly owner: StorageOwner;
};

type NativeGitBundleMarker = {
  readonly schemaVersion: 1;
  readonly stateFormat: 3;
  readonly database: typeof databaseName;
  readonly schemaManifestSha256: string;
};

export async function initializeNativeGitBundleState(stateDirectory: string): Promise<NativeGitBundleState> {
  await ensureStateDirectory(stateDirectory);
  const owner = await acquireStorageOwner(stateDirectory);
  try {
    const entries = await readdir(stateDirectory);
    const database = join(stateDirectory, databaseName);
    if (entries.length === 1 && entries[0] === ownerDatabaseName) {
      const sqlite = openDatabase(database);
      sqlite.close();
      await chmod(database, 0o600);
      await syncPath(database);
      await syncDirectory(stateDirectory);
      await publishMarker(join(stateDirectory, markerName), expectedMarker());
      await syncDirectory(stateDirectory);
    } else {
      await validateStateFiles(stateDirectory, entries);
    }
    return { database, stateFormat: 3, owner };
  } catch (error) {
    await owner.release();
    throw error;
  }
}

export async function inspectNativeGitBundleState(
  stateDirectory: string
): Promise<{ readonly stateFormat: 3 }> {
  await assertDirectory(stateDirectory);
  const entries = await readdir(stateDirectory);
  assertKnownEntries(entries);
  await inspectStorageOwner(stateDirectory);
  await validateStateFiles(stateDirectory, entries);
  return { stateFormat: 3 };
}

function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path, { defensive: true });
  database.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; ${activationSchema}; PRAGMA user_version = 3;`);
  return database;
}

async function validateStateFiles(stateDirectory: string, entries: readonly string[]): Promise<void> {
  assertKnownEntries(entries);
  if (!entries.includes(markerName)) throw new NativeGitBundleStateError("native Git bundle state marker is missing");
  if (!entries.includes(databaseName)) throw new NativeGitBundleStateError("native Git idle database is missing");
  const marker = await readMarker(join(stateDirectory, markerName));
  const database = new DatabaseSync(join(stateDirectory, databaseName), { readOnly: true, defensive: true });
  try {
    assertDatabaseSchema(database);
  } finally {
    database.close();
  }
  if (marker.schemaManifestSha256 !== schemaManifestSha256()) {
    throw new NativeGitBundleStateError("native Git bundle marker does not match the database schema manifest");
  }
}

function assertDatabaseSchema(database: DatabaseSync): void {
  const version = numberField(database.prepare("PRAGMA user_version").get(), "user_version");
  const rows = database.prepare(
    "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ).all();
  if (version !== 3 || rows.length !== 1) throw new NativeGitBundleStateError("native Git idle database schema is unsupported");
  const row = rows[0];
  if (!isRecord(row) || row.type !== "table" || row.name !== "bundle_activation"
    || typeof row.sql !== "string" || normalizeSql(row.sql) !== normalizeSql(activationSchema)) {
    throw new NativeGitBundleStateError("native Git idle database schema is unsupported");
  }
}

async function ensureStateDirectory(path: string): Promise<void> {
  try {
    await assertDirectory(path);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
    await mkdir(path, { mode: 0o750 });
  }
}

async function assertDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new NativeGitBundleStateError("native Git bundle state path must be a directory");
  }
}

function assertKnownEntries(entries: readonly string[]): void {
  const unknown = entries.find((entry) => !allowedEntries.has(entry));
  if (unknown !== undefined) throw new NativeGitBundleStateError(`unknown native Git state entry '${basename(unknown)}'`);
}

async function publishMarker(path: string, marker: NativeGitBundleMarker): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o444);
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.chmod(0o444);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function readMarker(path: string): Promise<NativeGitBundleMarker> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new NativeGitBundleStateError("native Git bundle state marker must be a regular file");
    let value: unknown;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new NativeGitBundleStateError("native Git bundle state marker is invalid");
      throw error;
    }
    if (!isRecord(value) || Object.keys(value).length !== 4 || value.schemaVersion !== 1 || value.stateFormat !== 3
      || value.database !== databaseName || typeof value.schemaManifestSha256 !== "string"
      || value.schemaManifestSha256 !== schemaManifestSha256()) {
      throw new NativeGitBundleStateError("native Git bundle state marker is invalid");
    }
    return expectedMarker();
  } finally {
    await handle.close();
  }
}

function expectedMarker(): NativeGitBundleMarker {
  return { schemaVersion: 1, stateFormat: 3, database: databaseName, schemaManifestSha256: schemaManifestSha256() };
}

function schemaManifestSha256(): string {
  return `sha256:${createHash("sha256").update(`3\n${normalizeSql(activationSchema)}\n`).digest("hex")}`;
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function numberField(value: unknown, field: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[field];
  return typeof fieldValue === "number" ? fieldValue : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export class NativeGitBundleStateError extends Error {
  readonly name = "NativeGitBundleStateError";
}
