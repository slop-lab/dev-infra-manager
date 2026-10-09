import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  assertNativeProjectRegistrationRows,
  nativeProjectRegistrationSchema,
  type NativeProjectRegistration
} from "./native-project-registry-state.js";
import {
  assertNativeProjectRootImportRows,
  nativeProjectRootImportSchema,
  type NativeProjectRootImport
} from "./native-project-root-import-state.js";
import { nativeProjectStorageNames } from "./native-project-storage.js";
import {
  assertNativeProjectRootPromotionRows,
  nativeProjectRootPromotionFinalizedSchema,
  nativeProjectRootPromotionIntentSchema
} from "./native-project-root-promotion-state.js";
import { assertDurableNativeRootBundle } from "./native-root-import-storage.js";
import {
  inspectNativeRootImportStaging,
  type NativeRootImportReconciliation
} from "./native-root-import-reconciliation.js";
import {
  NativeGitBundleMarkerError,
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
const stateEntries = new Set([ownerDatabaseName, databaseName, markerName]);

export function createNativeGitBundleDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path, { defensive: true });
  database.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;
    ${activationSchema}; ${nativeProjectRegistrationSchema}; ${nativeProjectRootImportSchema};
    ${nativeProjectRootPromotionFinalizedSchema}; ${nativeProjectRootPromotionIntentSchema}; PRAGMA user_version = 8;`);
  return database;
}

export async function validateNativeGitBundleStateFiles(
  stateDirectory: string,
  entries: readonly string[]
): Promise<{
  readonly registrations: readonly NativeProjectRegistration[];
  readonly imports: readonly NativeProjectRootImport[];
  readonly reconcileRootImports: NativeRootImportReconciliation;
}> {
  if (!entries.includes(markerName)) throw new NativeGitBundleStateError("native Git bundle state marker is missing");
  if (!entries.includes(databaseName)) throw new NativeGitBundleStateError("native Git idle database is missing");
  const marker = await readMarker(stateDirectory);
  const databaseUrl = pathToFileURL(join(stateDirectory, databaseName));
  databaseUrl.searchParams.set("immutable", "1");
  const database = new DatabaseSync(databaseUrl, { readOnly: true, defensive: true });
  try {
    const persisted = assertDatabaseSchema(database);
    await assertKnownEntries(stateDirectory, entries, nativeProjectStorageNames(persisted.registrations));
    await Promise.all(persisted.imports.filter((entry) => entry.phase !== "intent").map((entry) =>
      assertDurableNativeRootBundle(stateDirectory, entry.projectId, entry.importNonce,
        entry.bundleDigest, entry.bundleSize)));
    if (marker.schemaManifestSha256 !== schemaManifestSha256()) {
      throw new NativeGitBundleStateError("native Git bundle marker does not match the database schema manifest");
    }
    const reconcileRootImports = await inspectNativeRootImportStaging(
      stateDirectory, persisted.registrations, persisted.imports
    );
    return { ...persisted, reconcileRootImports };
  } finally {
    database.close();
  }
}

export function expectedNativeGitBundleMarker(): NativeGitBundleMarker {
  return { schemaVersion: 1, stateFormat: 8, database: databaseName, schemaManifestSha256: schemaManifestSha256() };
}

function assertDatabaseSchema(database: DatabaseSync): {
  readonly registrations: readonly NativeProjectRegistration[];
  readonly imports: readonly NativeProjectRootImport[];
} {
  const version = numberField(database.prepare("PRAGMA user_version").get(), "user_version");
  const rows = database.prepare(
    "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ).all();
  if (version !== 8 || rows.length !== 5
    || !schemaRowEquals(rows[0], "bundle_activation", activationSchema)
    || !schemaRowEquals(rows[1], "native_project_registration", nativeProjectRegistrationSchema)
    || !schemaRowEquals(rows[2], "native_project_root_import", nativeProjectRootImportSchema)
    || !schemaRowEquals(rows[3], "native_project_root_promotion_finalized", nativeProjectRootPromotionFinalizedSchema)
    || !schemaRowEquals(rows[4], "native_project_root_promotion_intent", nativeProjectRootPromotionIntentSchema)) {
    throw new NativeGitBundleStateError("native Git idle database schema is unsupported");
  }
  const registrations = assertNativeProjectRegistrationRows(database);
  assertNativeProjectRootPromotionRows(database);
  return { registrations, imports: assertNativeProjectRootImportRows(database) };
}

async function readMarker(stateDirectory: string): Promise<NativeGitBundleMarker> {
  try {
    return await readNativeGitBundleMarker(join(stateDirectory, markerName), expectedNativeGitBundleMarker());
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
    if (stateEntries.has(entry)) continue;
    if (!projectIds.has(entry)) throw new NativeGitBundleStateError(`unknown native Git state entry '${basename(entry)}'`);
    const metadata = await lstat(join(stateDirectory, entry));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new NativeGitBundleStateError(`registered native Project storage '${basename(entry)}' is invalid`);
    }
  }
}

function schemaManifestSha256(): string {
  return `sha256:${createHash("sha256").update(
    `8\n${normalizeSql(activationSchema)}\n${normalizeSql(nativeProjectRegistrationSchema)}\n`
      + `${normalizeSql(nativeProjectRootImportSchema)}\n${normalizeSql(nativeProjectRootPromotionFinalizedSchema)}\n`
      + `${normalizeSql(nativeProjectRootPromotionIntentSchema)}\n`
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
