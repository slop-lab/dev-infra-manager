import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  assertActivatedGeneration,
  type NativeProjectRegistration,
  selectRegistration
} from "./native-project-registry-state.js";
import {
  NativeProjectRootImportConflictError,
  NativeProjectRootImportOwnershipError,
  NativeProjectRootImportStateError,
  parseNativeProjectRootImportInput,
  parseNativeProjectRootImportRow,
  type NativeProjectRootImport,
  type NativeProjectRootImportDurable,
  type NativeProjectRootImportInput,
  type NativeProjectRootImportIntent,
  type NativeProjectRootImportInstalled
} from "./native-project-root-import-codec.js";

export const nativeProjectRootImportSchema = `CREATE TABLE native_project_root_import (
  project_id TEXT PRIMARY KEY REFERENCES native_project_registration(project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  service_id TEXT NOT NULL CHECK (service_id = 'native-main'),
  root_repository_id TEXT NOT NULL CHECK (root_repository_id = 'root'),
  owner_host_id TEXT NOT NULL
    CHECK (length(owner_host_id) BETWEEN 1 AND 128
      AND owner_host_id NOT GLOB '*[^a-z0-9._-]*'
      AND substr(owner_host_id, 1, 1) GLOB '[a-z0-9]'),
  generation_id TEXT NOT NULL REFERENCES bundle_activation(generation_id) ON UPDATE RESTRICT ON DELETE RESTRICT
    CHECK (length(generation_id) = 64 AND generation_id NOT GLOB '*[^0-9a-f]*'),
  import_nonce TEXT NOT NULL UNIQUE CHECK (length(import_nonce) = 36),
  protected_ref TEXT NOT NULL CHECK (length(protected_ref) BETWEEN 1 AND 1024),
  expected_commit TEXT NOT NULL
    CHECK ((length(expected_commit) = 40 OR length(expected_commit) = 64)
      AND expected_commit NOT GLOB '*[^0-9a-f]*'),
  policy_json TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL
    CHECK (length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  bundle_sha256 TEXT
    CHECK (bundle_sha256 IS NULL OR (length(bundle_sha256) = 64 AND bundle_sha256 NOT GLOB '*[^0-9a-f]*')),
  bundle_size INTEGER CHECK (bundle_size IS NULL OR bundle_size BETWEEN 1 AND 268435456),
  resolved_tree TEXT
    CHECK (resolved_tree IS NULL OR ((length(resolved_tree) = 40 OR length(resolved_tree) = 64)
      AND resolved_tree NOT GLOB '*[^0-9a-f]*')),
  phase TEXT NOT NULL CHECK (phase IN ('intent', 'bundle-durable', 'installing', 'objects-installed', 'root-imported')),
  CHECK ((phase = 'intent' AND bundle_sha256 IS NULL AND bundle_size IS NULL AND resolved_tree IS NULL)
    OR (phase IN ('bundle-durable', 'installing') AND bundle_sha256 IS NOT NULL
      AND bundle_size IS NOT NULL AND resolved_tree IS NULL)
    OR (phase IN ('objects-installed', 'root-imported') AND bundle_sha256 IS NOT NULL
      AND bundle_size IS NOT NULL AND resolved_tree IS NOT NULL))
) STRICT`;

export function claimNativeProjectRootImportInDatabase(
  databasePath: string,
  requestedGenerationId: string,
  ownerHostId: string,
  input: unknown
): NativeProjectRootImport {
  const requested = parseNativeProjectRootImportInput(input);
  const database = new DatabaseSync(databasePath, { defensive: true });
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
    assertActivatedGeneration(database, requestedGenerationId);
    database.exec("BEGIN IMMEDIATE");
    try {
      assertActivatedGeneration(database, requestedGenerationId);
      const registration = selectRegistration(database, requested.projectId);
      assertPreparedRegistration(registration, requested, ownerHostId);
      const existing = selectImport(database, requested.projectId);
      const policyJson = JSON.stringify(requested.policy);
      const policyDigest = createHash("sha256").update(policyJson, "utf8").digest("hex");
      if (existing !== undefined) {
        assertSameIntent(existing, requestedGenerationId, ownerHostId, requested, policyJson, policyDigest);
        database.exec("COMMIT");
        return existing;
      }
      database.prepare(`INSERT INTO native_project_root_import
        (project_id, service_id, root_repository_id, owner_host_id, generation_id, import_nonce,
          protected_ref, expected_commit, policy_json, policy_sha256, phase)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent')`
      ).run(requested.projectId, requested.serviceId, requested.rootRepositoryId, ownerHostId,
        requestedGenerationId, randomUUID(), requested.protectedRef, requested.expectedCommit,
        policyJson, policyDigest);
      const claimed = selectImport(database, requested.projectId);
      if (claimed === undefined) throw new NativeProjectRootImportStateError("native Project root import intent was not stored");
      database.exec("COMMIT");
      return claimed;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function markNativeProjectRootBundleDurableInDatabase(
  databasePath: string,
  projectId: string,
  importNonce: string,
  bundleDigest: string,
  bundleSize: number
): NativeProjectRootImportDurable | NativeProjectRootImportInstalled {
  const metadata = parseBundleMetadata({ projectId, importNonce, bundleDigest, bundleSize });
  const database = new DatabaseSync(databasePath, { defensive: true });
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    const existing = selectImport(database, metadata.projectId);
    if (existing === undefined || existing.importNonce !== metadata.importNonce) {
      throw new NativeProjectRootImportConflictError(metadata.projectId);
    }
    if (existing.phase === "bundle-durable" || existing.phase === "root-imported") {
      if (existing.bundleDigest !== metadata.bundleDigest || existing.bundleSize !== metadata.bundleSize) {
        throw new NativeProjectRootImportConflictError(metadata.projectId);
      }
      database.exec("COMMIT");
      return existing;
    }
    database.prepare(`UPDATE native_project_root_import
      SET bundle_sha256 = ?, bundle_size = ?, phase = 'bundle-durable'
      WHERE project_id = ? AND import_nonce = ? AND phase = 'intent'`
    ).run(metadata.bundleDigest, metadata.bundleSize, metadata.projectId, metadata.importNonce);
    const durable = selectImport(database, metadata.projectId);
    if (durable === undefined || durable.phase !== "bundle-durable") {
      throw new NativeProjectRootImportStateError("native Project root bundle durability was not stored");
    }
    database.exec("COMMIT");
    return durable;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export function assertNativeProjectRootImportRows(database: DatabaseSync): readonly NativeProjectRootImport[] {
  const rows = database.prepare(`SELECT service_id, project_id, root_repository_id, owner_host_id,
    generation_id, import_nonce, protected_ref, expected_commit, policy_json, policy_sha256,
    bundle_sha256, bundle_size, resolved_tree, phase
    FROM native_project_root_import ORDER BY project_id`).all();
  const imports: NativeProjectRootImport[] = [];
  for (const row of rows) {
    const intent = parseNativeProjectRootImportRow(row);
    assertActivatedGeneration(database, intent.generationId);
    const registration = selectRegistration(database, intent.projectId);
    assertPreparedRegistration(registration, intent, intent.ownerHostId);
    imports.push(intent);
  }
  return imports;
}

function selectImport(database: DatabaseSync, projectId: string): NativeProjectRootImport | undefined {
  const row = database.prepare(`SELECT service_id, project_id, root_repository_id, owner_host_id,
    generation_id, import_nonce, protected_ref, expected_commit, policy_json, policy_sha256,
    bundle_sha256, bundle_size, resolved_tree, phase
    FROM native_project_root_import WHERE project_id = ?`).get(projectId);
  return row === undefined ? undefined : parseNativeProjectRootImportRow(row);
}

function assertPreparedRegistration(
  registration: NativeProjectRegistration | undefined,
  requested: Pick<NativeProjectRootImportIntent, "serviceId" | "projectId" | "rootRepositoryId">,
  ownerHostId: string
): asserts registration is NativeProjectRegistration {
  if (registration === undefined || registration.phase !== "root-prepared") {
    throw new NativeProjectRootImportStateError("native Project root import requires a prepared root");
  }
  if (registration.ownerHostId !== ownerHostId) throw new NativeProjectRootImportOwnershipError();
  if (registration.serviceId !== requested.serviceId || registration.rootRepositoryId !== requested.rootRepositoryId) {
    throw new NativeProjectRootImportConflictError(requested.projectId);
  }
}

function assertSameIntent(
  existing: NativeProjectRootImport,
  requestedGenerationId: string,
  ownerHostId: string,
  requested: NativeProjectRootImportInput,
  policyJson: string,
  policyDigest: string
): void {
  if (existing.ownerHostId !== ownerHostId) throw new NativeProjectRootImportOwnershipError();
  if (existing.generationId !== requestedGenerationId || existing.serviceId !== requested.serviceId
    || existing.rootRepositoryId !== requested.rootRepositoryId || existing.protectedRef !== requested.protectedRef
    || existing.expectedCommit !== requested.expectedCommit || JSON.stringify(existing.policy) !== policyJson
    || existing.policyDigest !== policyDigest) {
    throw new NativeProjectRootImportConflictError(requested.projectId);
  }
}

function parseBundleMetadata(value: unknown): {
  readonly projectId: string; readonly importNonce: string; readonly bundleDigest: string; readonly bundleSize: number;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new NativeProjectRootImportStateError();
  const projectId = Reflect.get(value, "projectId");
  const importNonce = Reflect.get(value, "importNonce");
  const bundleDigest = Reflect.get(value, "bundleDigest");
  const bundleSize = Reflect.get(value, "bundleSize");
  if (typeof projectId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(projectId)
    || typeof importNonce !== "string" || !/^[0-9a-f-]{36}$/.test(importNonce)
    || typeof bundleDigest !== "string" || !/^[0-9a-f]{64}$/.test(bundleDigest)
    || typeof bundleSize !== "number" || !Number.isInteger(bundleSize) || bundleSize < 1 || bundleSize > 256 * 1024 * 1024) {
    throw new NativeProjectRootImportStateError("native Project root bundle metadata is invalid");
  }
  return { projectId, importNonce, bundleDigest, bundleSize };
}

export {
  NativeProjectRootImportConflictError,
  NativeProjectRootImportOwnershipError,
  NativeProjectRootImportStateError
} from "./native-project-root-import-codec.js";
export type {
  NativeProjectRootImport,
  NativeProjectRootImportDurable,
  NativeProjectRootImportIntent,
  NativeProjectRootImportInstalled
} from "./native-project-root-import-codec.js";
