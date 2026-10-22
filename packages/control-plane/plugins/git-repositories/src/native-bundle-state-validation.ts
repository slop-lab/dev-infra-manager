import { repositoryPolicyUpdateSchema } from "./repository-policy-state.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  assertNativeProjectRegistrationRows,
  nativeProjectRegistrationSchema,
  nativeRepositoryRegistrationSchema,
  type NativeProjectRegistration
} from "./native-project-registry-state.js";
import {
  assertNativeProjectRootImportRows,
  nativeProjectRootImportSchema,
  type NativeProjectRootImport
} from "./native-project-root-import-state.js";
import { nativeProjectStorageNames } from "./native-project-storage.js";
import { assertRepositoryRefTransitions, repositoryRefTransitionSchema } from "./repository-ref-state.js";
import { assertDurableNativeRootBundle } from "./native-root-import-storage.js";
import {
  inspectNativeRootImportStaging,
  type NativeRootImportReconciliation
} from "./native-root-import-reconciliation.js";
import {
  NativeGitBundleMarkerError,
  publishNativeGitBundleMarker,
  syncNativeGitBundlePath,
  readNativeGitBundleMarker,
  type NativeGitBundleMarker
} from "./native-bundle-state-marker.js";

const ownerDatabaseName = ".dim-native-git-owner.sqlite3";
const databaseName = "native-idle.sqlite3";
const markerName = "state-format.json";
const activationSchema = `CREATE TABLE bundle_activation (
  generation_id TEXT PRIMARY KEY CHECK (length(generation_id) = 64 AND generation_id NOT GLOB '*[^0-9a-f]*'),
  activation_token_sha256 TEXT NOT NULL UNIQUE
    CHECK (length(activation_token_sha256) = 64 AND activation_token_sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT`;
const stateEntries = new Set([ownerDatabaseName, databaseName, markerName, ".extensions"]);

export function createNativeGitBundleDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path, { defensive: true });
  database.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;
    ${activationSchema}; ${nativeProjectRegistrationSchema}; ${nativeRepositoryRegistrationSchema}; ${nativeProjectRootImportSchema};
    ${repositoryRefTransitionSchema}; ${repositoryPolicyUpdateSchema}; PRAGMA user_version = 11;`);
  return database;
}

export async function validateNativeGitBundleStateFiles(
  stateDirectory: string,
  entries: readonly string[],
  recoveringPolicyUpgrade = false
): Promise<{
  readonly stateFormat: 10 | 11;
  readonly registrations: readonly NativeProjectRegistration[];
  readonly imports: readonly NativeProjectRootImport[];
  readonly reconcileRootImports: NativeRootImportReconciliation;
}> {
  if (!entries.includes(markerName)) throw new NativeGitBundleStateError("native Git bundle state marker is missing");
  if (!entries.includes(databaseName)) throw new NativeGitBundleStateError("native Git idle database is missing");
  const marker = await readMarker(stateDirectory);
  await assertPrivateOwnedDatabase(join(stateDirectory, databaseName));
  const databaseUrl = pathToFileURL(join(stateDirectory, databaseName));
  databaseUrl.searchParams.set("immutable", "1");
  const database = new DatabaseSync(databaseUrl, { readOnly: true, defensive: true });
  try {
    const actualVersion = numberField(database.prepare("PRAGMA user_version").get(), "user_version");
    const stateFormat = recoveringPolicyUpgrade && marker.stateFormat === 10 && actualVersion === 11 ? 11 : marker.stateFormat;
    const persisted = assertDatabaseSchema(database, stateFormat);
    await assertKnownEntries(stateDirectory, entries, nativeProjectStorageNames(persisted.registrations));
    await Promise.all(persisted.imports.filter((entry) => entry.phase !== "intent").map((entry) =>
      assertDurableNativeRootBundle(stateDirectory, entry.projectId, entry.repositoryId, entry.importNonce,
        entry.bundleDigest, entry.bundleSize)));
    if (marker.schemaManifestSha256 !== schemaManifestSha256(marker.stateFormat)) {
      throw new NativeGitBundleStateError("native Git bundle marker does not match the database schema manifest");
    }
    const reconcileRootImports = await inspectNativeRootImportStaging(
      stateDirectory, persisted.registrations, persisted.imports
    );
    return { ...persisted, stateFormat, reconcileRootImports };
  } finally {
    database.close();
  }
}

export function expectedNativeGitBundleMarker(): NativeGitBundleMarker {
  return { schemaVersion: 1, stateFormat: 11, database: databaseName, schemaManifestSha256: schemaManifestSha256() };
}

function assertDatabaseSchema(database: DatabaseSync, expectedVersion: 10 | 11 = 11): {
  readonly registrations: readonly NativeProjectRegistration[];
  readonly imports: readonly NativeProjectRootImport[];
} {
  const version = numberField(database.prepare("PRAGMA user_version").get(), "user_version");
  const rows = database.prepare(
    "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ).all();
  if (version !== expectedVersion || rows.length !== (expectedVersion === 10 ? 5 : 6)
    || !schemaRowEquals(rows[0], "bundle_activation", activationSchema)
    || !schemaRowEquals(rows[1], "native_project_registration", nativeProjectRegistrationSchema)
    || !schemaRowEquals(rows[2], "native_project_root_import", nativeProjectRootImportSchema)
    || !schemaRowEquals(rows[3], "native_repository_registration", nativeRepositoryRegistrationSchema)
    || !schemaRowEquals(rows[4], expectedVersion === 10 ? "repository_ref_transition" : "repository_policy_update", expectedVersion === 10 ? repositoryRefTransitionSchema : repositoryPolicyUpdateSchema)
    || (expectedVersion === 11 && !schemaRowEquals(rows[5], "repository_ref_transition", repositoryRefTransitionSchema))) {
    throw new NativeGitBundleStateError("native Git idle database schema is unsupported");
  }
  const registrations = assertNativeProjectRegistrationRows(database);
  assertRepositoryRefTransitions(database, expectedVersion === 10 ? [] : undefined);
  return { registrations, imports: assertNativeProjectRootImportRows(database) };
}

async function readMarker(stateDirectory: string): Promise<NativeGitBundleMarker> {
  try {
    try { return await readNativeGitBundleMarker(join(stateDirectory, markerName), expectedNativeGitBundleMarker()); }
    catch (error) {
      if (!(error instanceof NativeGitBundleMarkerError)) throw error;
      return await readNativeGitBundleMarker(join(stateDirectory, markerName), { schemaVersion: 1, stateFormat: 10, database: databaseName, schemaManifestSha256: schemaManifestSha256(10) });
    }
  } catch (error) {
    if (error instanceof NativeGitBundleMarkerError) {
      throw new NativeGitBundleStateError(error.message, { cause: error });
    }
    throw error;
  }
}

async function assertKnownEntries(
  stateDirectory: string,
  entries: readonly string[],
  projectIds: ReadonlySet<string>
): Promise<void> {
  for (const entry of entries) {
    if (stateEntries.has(entry)) {
      if (entry === ".extensions") {
        const metadata = await lstat(join(stateDirectory, entry));
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) throw new NativeGitBundleStateError("repository extension state is not private and owned");
      }
      continue;
    }
    if (!projectIds.has(entry)) throw new NativeGitBundleStateError(`unknown native Git state entry '${basename(entry)}'`);
    const metadata = await lstat(join(stateDirectory, entry));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new NativeGitBundleStateError(`registered native Project storage '${basename(entry)}' is invalid`);
    }
  }
}

function schemaManifestSha256(version: 10 | 11 = 11): string {
  return `sha256:${createHash("sha256").update(
    `${version}\n${normalizeSql(activationSchema)}\n${normalizeSql(nativeProjectRegistrationSchema)}\n`
      + `${normalizeSql(nativeRepositoryRegistrationSchema)}\n${normalizeSql(nativeProjectRootImportSchema)}\n${normalizeSql(repositoryRefTransitionSchema)}\n`
      + (version === 11 ? `${normalizeSql(repositoryPolicyUpdateSchema)}\n` : "")
  ).digest("hex")}`;
}

function schemaRowEquals(row: unknown, name: string, sql: string): boolean {
  return isRecord(row) && row.type === "table" && row.name === name
    && typeof row.sql === "string" && normalizeSql(row.sql) === normalizeSql(sql);
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

export class NativeGitBundleStateError extends Error {
  readonly name = "NativeGitBundleStateError";
}

/** Additive upgrade preserves immutable import receipts, ref history and all extension data.
 * A crash after the database commit is recovered by publishing the new marker on retry. */
export async function upgradeNativeGitBundlePolicyState(stateDirectory: string): Promise<void> {
  const markerPath = join(stateDirectory, markerName);
  let oldMarker = false;
  try { await readNativeGitBundleMarker(markerPath, { schemaVersion: 1, stateFormat: 10, database: databaseName, schemaManifestSha256: schemaManifestSha256(10) }); oldMarker = true; }
  catch (error) { if (!(error instanceof NativeGitBundleMarkerError)) throw error; }
  if (!oldMarker) return;
  await validateNativeGitBundleStateFiles(stateDirectory, await readdir(stateDirectory), true);
  const database = new DatabaseSync(join(stateDirectory, databaseName), { defensive: true });
  try {
    const version = numberField(database.prepare("PRAGMA user_version").get(), "user_version");
    if (version === 10) {
      assertDatabaseSchema(database, 10);
      database.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      try { database.exec(`${repositoryPolicyUpdateSchema}; PRAGMA user_version=11;`); assertDatabaseSchema(database); database.exec("COMMIT"); }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    } else { assertDatabaseSchema(database); }
  } finally { database.close(); }
  await syncNativeGitBundlePath(join(stateDirectory, databaseName), false);
  await publishNativeGitBundleMarker(markerPath, expectedNativeGitBundleMarker());
  await syncNativeGitBundlePath(stateDirectory, true);
}

async function assertPrivateOwnedDatabase(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw new NativeGitBundleStateError("native Git database must be private and owned");
  } finally { await handle.close(); }
}
