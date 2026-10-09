import { DatabaseSync } from "node:sqlite";
import {
  type NativeProjectRootImport,
  type NativeProjectRootImportFinalizeSelector,
  type NativeProjectRootImportInstalled,
  NativeProjectRootImportConflictError,
  NativeProjectRootImportOwnershipError,
  NativeProjectRootImportStateError,
  parseNativeProjectRootImportRow
} from "./native-project-root-import-codec.js";
import { assertActivatedGeneration, selectRegistration } from "./native-project-registry-state.js";

const selectSql = `SELECT service_id, project_id, root_repository_id, owner_host_id,
  generation_id, import_nonce, protected_ref, expected_commit, policy_json, policy_sha256,
  bundle_sha256, bundle_size, resolved_tree, phase
  FROM native_project_root_import`;

export function beginNativeProjectRootImportInstallationInDatabase(
  databasePath: string,
  projectId: string,
  ownerHostId: string,
  selector: NativeProjectRootImportFinalizeSelector
): NativeProjectRootImport {
  return mutateImport(databasePath, projectId, (database, existing) => {
    assertFinalizeBinding(database, existing, projectId, ownerHostId, selector);
    if (existing.phase === "intent") throw new NativeProjectRootImportConflictError(projectId);
    if (existing.phase !== "bundle-durable") return existing;
    database.prepare(`UPDATE native_project_root_import SET phase = 'installing'
      WHERE project_id = ? AND phase = 'bundle-durable'`).run(projectId);
    return requireImport(database, projectId);
  });
}

export function markNativeProjectRootObjectsInstalledInDatabase(
  databasePath: string,
  projectId: string,
  selector: NativeProjectRootImportFinalizeSelector,
  resolvedTree: string
): NativeProjectRootImportInstalled {
  if (!objectIdMatches(resolvedTree)) {
    throw new NativeProjectRootImportStateError("native Project root import resolved tree is invalid");
  }
  return mutateImport(databasePath, projectId, (database, existing) => {
    assertSelector(existing, projectId, selector);
    if (existing.phase === "objects-installed" || existing.phase === "root-imported") {
      if (existing.resolvedTree !== resolvedTree) throw new NativeProjectRootImportConflictError(projectId);
      return existing;
    }
    if (existing.phase !== "installing") throw new NativeProjectRootImportConflictError(projectId);
    database.prepare(`UPDATE native_project_root_import SET resolved_tree = ?, phase = 'objects-installed'
      WHERE project_id = ? AND phase = 'installing'`).run(resolvedTree, projectId);
    const installed = requireImport(database, projectId);
    if (installed.phase !== "objects-installed") {
      throw new NativeProjectRootImportStateError("native Project root object installation was not stored");
    }
    return installed;
  });
}

export function markNativeProjectRootImportedInDatabase(
  databasePath: string,
  projectId: string,
  selector: NativeProjectRootImportFinalizeSelector,
  resolvedTree: string
): NativeProjectRootImportInstalled {
  return mutateImport(databasePath, projectId, (database, existing) => {
    assertSelector(existing, projectId, selector);
    if (existing.phase === "root-imported") {
      if (existing.resolvedTree !== resolvedTree) throw new NativeProjectRootImportConflictError(projectId);
      return existing;
    }
    if (existing.phase !== "objects-installed" || existing.resolvedTree !== resolvedTree) {
      throw new NativeProjectRootImportConflictError(projectId);
    }
    database.prepare(`UPDATE native_project_root_import SET phase = 'root-imported'
      WHERE project_id = ? AND phase = 'objects-installed'`).run(projectId);
    const imported = requireImport(database, projectId);
    if (imported.phase !== "root-imported") {
      throw new NativeProjectRootImportStateError("native Project root import completion was not stored");
    }
    return imported;
  });
}

export function readNativeProjectRootImportsFromDatabase(
  databasePath: string
): readonly NativeProjectRootImport[] {
  const database = new DatabaseSync(databasePath, { readOnly: true, defensive: true });
  try {
    return database.prepare(`${selectSql} ORDER BY project_id`).all().map(parseNativeProjectRootImportRow);
  } finally {
    database.close();
  }
}

function mutateImport<T>(
  databasePath: string,
  projectId: string,
  mutation: (database: DatabaseSync, existing: NativeProjectRootImport) => T
): T {
  const database = new DatabaseSync(databasePath, { defensive: true });
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    try {
      const result = mutation(database, requireImport(database, projectId));
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function assertFinalizeBinding(
  database: DatabaseSync,
  existing: NativeProjectRootImport,
  projectId: string,
  ownerHostId: string,
  selector: NativeProjectRootImportFinalizeSelector
): void {
  assertSelector(existing, projectId, selector);
  assertActivatedGeneration(database, selector.generationId);
  const registration = selectRegistration(database, projectId);
  if (registration === undefined || registration.phase !== "root-prepared") {
    throw new NativeProjectRootImportStateError("native Project root import requires a prepared root");
  }
  if (existing.ownerHostId !== ownerHostId || registration.ownerHostId !== ownerHostId) {
    throw new NativeProjectRootImportOwnershipError();
  }
  if (registration.serviceId !== existing.serviceId
    || registration.rootRepositoryId !== existing.rootRepositoryId) {
    throw new NativeProjectRootImportConflictError(projectId);
  }
}

function assertSelector(
  existing: NativeProjectRootImport,
  projectId: string,
  selector: NativeProjectRootImportFinalizeSelector
): void {
  if (existing.projectId !== projectId || existing.generationId !== selector.generationId
    || existing.importNonce !== selector.importNonce || existing.bundleDigest !== selector.bundleDigest) {
    throw new NativeProjectRootImportConflictError(projectId);
  }
}

function requireImport(database: DatabaseSync, projectId: string): NativeProjectRootImport {
  const row = database.prepare(`${selectSql} WHERE project_id = ?`).get(projectId);
  if (row === undefined) throw new NativeProjectRootImportConflictError(projectId);
  return parseNativeProjectRootImportRow(row);
}

function objectIdMatches(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}
