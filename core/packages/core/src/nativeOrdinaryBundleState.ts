import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { UserError } from "./errors.js";
import {
  assertNativeOrdinarySchema,
  nativeOrdinarySchemaManifestSha256,
  openNativeOrdinaryDatabase
} from "./nativeOrdinaryAuthoritySchema.js";
import {
  assertOrdinaryStateDirectory,
  assertOrdinaryStateFile,
  openOrdinaryStateFile,
  setPrivateFileMode
} from "./nativeOrdinaryBundleFilesystem.js";
import { copyNativeOrdinaryBundleSnapshot } from "./nativeOrdinaryBundleSnapshot.js";

const databaseName = "ordinary-ci.sqlite3";
const markerName = "state-format.json";
const allowedEntries = new Set([databaseName, markerName, `${databaseName}-wal`, `${databaseName}-shm`]);

export type NativeOrdinaryBundleState = {
  readonly database: string;
  readonly stateFormat: 3;
};

type NativeOrdinaryBundleMarker = {
  readonly schemaVersion: 1;
  readonly stateFormat: 3;
  readonly database: typeof databaseName;
  readonly schemaManifestSha256: string;
};

export function nativeOrdinaryBundleMarkerPath(stateDirectory: string): string {
  return join(stateDirectory, markerName);
}

export async function initializeNativeOrdinaryBundleState(stateDirectory: string): Promise<NativeOrdinaryBundleState> {
  await ensureStateDirectory(stateDirectory);
  const entries = await readdir(stateDirectory);
  const database = join(stateDirectory, databaseName);
  const marker = nativeOrdinaryBundleMarkerPath(stateDirectory);
  if (entries.length === 0) {
    openNativeOrdinaryDatabase(database).close();
    await setPrivateFileMode(database);
    await syncPath(database);
    await syncDirectory(stateDirectory);
    await publishMarker(marker, expectedMarker());
    await syncDirectory(stateDirectory);
    return { database, stateFormat: 3 };
  }
  assertKnownEntries(entries);
  if (!entries.includes(markerName)) throw new UserError("ordinary CI bundle state marker is missing; existing databases are not adopted");
  if (!entries.includes(databaseName)) throw new UserError("ordinary CI bundle database is missing");
  await assertStateEntryMetadata(stateDirectory, entries);
  const parsed = await readMarker(marker);
  const manifest = assertNativeOrdinarySchema(database);
  if (parsed.schemaManifestSha256 !== manifest) {
    throw new UserError("ordinary CI bundle marker does not match the database schema manifest");
  }
  return { database, stateFormat: 3 };
}

export async function inspectNativeOrdinaryBundleState(
  stateDirectory: string
): Promise<{ readonly stateFormat: 3 }> {
  await assertOrdinaryStateDirectory(stateDirectory);
  const entries = await readdir(stateDirectory);
  assertKnownEntries(entries);
  if (!entries.includes(markerName)) throw new UserError("ordinary CI bundle state marker is missing");
  if (!entries.includes(databaseName)) throw new UserError("ordinary CI bundle database is missing");
  const copyDirectory = await mkdtemp(join(tmpdir(), "dim-ordinary-state-probe-"));
  try {
    const snapshot = await copyNativeOrdinaryBundleSnapshot(stateDirectory, copyDirectory, entries);
    const marker = parseMarker(snapshot.markerJson);
    const manifest = assertNativeOrdinarySchema(snapshot.database);
    if (marker.schemaManifestSha256 !== manifest) {
      throw new UserError("ordinary CI bundle marker does not match the database schema manifest");
    }
    return { stateFormat: 3 };
  } finally {
    await rm(copyDirectory, { recursive: true, force: true });
  }
}

async function ensureStateDirectory(stateDirectory: string): Promise<void> {
  try {
    await assertOrdinaryStateDirectory(stateDirectory);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await mkdir(stateDirectory, { mode: 0o750 });
    await chmod(stateDirectory, 0o750);
  }
}

function assertKnownEntries(entries: readonly string[]): void {
  const unknown = entries.find((entry) => !allowedEntries.has(entry));
  if (unknown !== undefined) throw new UserError(`unknown ordinary CI state entry '${basename(unknown)}'`);
}

async function publishMarker(path: string, marker: NativeOrdinaryBundleMarker): Promise<void> {
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

async function readMarker(path: string): Promise<NativeOrdinaryBundleMarker> {
  const openedFile = await openOrdinaryStateFile(path, 0o444, "ordinary CI bundle state marker");
  try {
    return parseMarker(await openedFile.handle.readFile("utf8"));
  } finally {
    await openedFile.handle.close();
  }
}

function parseMarker(contents: string): NativeOrdinaryBundleMarker {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError("ordinary CI bundle state marker must contain valid JSON");
    throw error;
  }
  if (!isRecord(value) || Object.keys(value).length !== 4 || value.schemaVersion !== 1 || value.stateFormat !== 3
    || value.database !== databaseName || typeof value.schemaManifestSha256 !== "string"
    || !/^sha256:[0-9a-f]{64}$/.test(value.schemaManifestSha256)) {
    throw new UserError("ordinary CI bundle state marker is invalid");
  }
  const expected = nativeOrdinarySchemaManifestSha256();
  if (value.schemaManifestSha256 !== expected) {
    throw new UserError("ordinary CI bundle marker schema manifest is unsupported");
  }
  return {
    schemaVersion: 1,
    stateFormat: 3,
    database: databaseName,
    schemaManifestSha256: value.schemaManifestSha256
  };
}

async function assertStateEntryMetadata(stateDirectory: string, entries: readonly string[]): Promise<void> {
  await Promise.all(entries.map(async (entry) => assertOrdinaryStateFile(
    join(stateDirectory, entry), entry === markerName ? 0o444 : 0o600,
    entry === markerName ? "ordinary CI bundle state marker" : "ordinary CI database state"
  )));
}

export async function secureNativeOrdinaryDatabaseFiles(stateDirectory: string): Promise<void> {
  const entries = await readdir(stateDirectory);
  await Promise.all([databaseName, `${databaseName}-wal`, `${databaseName}-shm`]
    .filter((entry) => entries.includes(entry))
    .map(async (entry) => setPrivateFileMode(join(stateDirectory, entry))));
}

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function expectedMarker(): NativeOrdinaryBundleMarker {
  return {
    schemaVersion: 1,
    stateFormat: 3,
    database: databaseName,
    schemaManifestSha256: nativeOrdinarySchemaManifestSha256()
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
