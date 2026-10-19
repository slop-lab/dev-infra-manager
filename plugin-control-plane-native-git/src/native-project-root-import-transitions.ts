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

const selectSql = `SELECT service_id, project_id, repository_id, owner_host_id,
  generation_id, import_nonce, protected_ref, expected_commit, policy_json, policy_sha256,
  bundle_sha256, bundle_size, resolved_tree, phase
  FROM native_project_root_import`;

export function beginNativeProjectRootImportInstallationInDatabase(
  databasePath: string,
  projectId: string,
  repositoryId: string,
  ownerHostId: string,
  selector: NativeProjectRootImportFinalizeSelector
): NativeProjectRootImport {
  return mutateImport(databasePath, projectId, repositoryId, (database, existing) => {
    assertFinalizeBinding(database, existing, projectId, repositoryId, ownerHostId, selector);
    if (existing.phase === "intent") throw new NativeProjectRootImportConflictError(projectId);
    if (existing.phase !== "bundle-durable") return existing;
    database.prepare(`UPDATE native_project_root_import SET phase = 'installing'
      WHERE project_id = ? AND repository_id = ? AND phase = 'bundle-durable'`).run(projectId, repositoryId);
    return requireImport(database, projectId, repositoryId);
  });
}

export function markNativeProjectRootObjectsInstalledInDatabase(
  databasePath: string,
  projectId: string,
  repositoryId: string,
  selector: NativeProjectRootImportFinalizeSelector,
  resolvedTree: string
): NativeProjectRootImportInstalled {
  if (!objectIdMatches(resolvedTree)) {
    throw new NativeProjectRootImportStateError("native Project root import resolved tree is invalid");
  }
  return mutateImport(databasePath, projectId, repositoryId, (database, existing) => {
    assertSelector(existing, projectId, repositoryId, selector);
    if (existing.phase === "objects-installed" || existing.phase === "repository-imported") {
      if (existing.resolvedTree !== resolvedTree) throw new NativeProjectRootImportConflictError(projectId);
      return existing;
    }
    if (existing.phase !== "installing") throw new NativeProjectRootImportConflictError(projectId);
    database.prepare(`UPDATE native_project_root_import SET resolved_tree = ?, phase = 'objects-installed'
      WHERE project_id = ? AND repository_id = ? AND phase = 'installing'`).run(resolvedTree, projectId, repositoryId);
    const installed = requireImport(database, projectId, repositoryId);
    if (installed.phase !== "objects-installed") {
      throw new NativeProjectRootImportStateError("native Project root object installation was not stored");
    }
    return installed;
  });
}

export function markNativeProjectRootImportedInDatabase(
  databasePath: string,
  projectId: string,
  repositoryId: string,
  selector: NativeProjectRootImportFinalizeSelector,
  resolvedTree: string
): NativeProjectRootImportInstalled {
  return mutateImport(databasePath, projectId, repositoryId, (database, existing) => {
    assertSelector(existing, projectId, repositoryId, selector);
    if (existing.phase === "repository-imported") {
      if (existing.resolvedTree !== resolvedTree) throw new NativeProjectRootImportConflictError(projectId);
      return existing;
    }
    if (existing.phase !== "objects-installed" || existing.resolvedTree !== resolvedTree) {
      throw new NativeProjectRootImportConflictError(projectId);
    }
    database.prepare(`UPDATE native_project_root_import SET phase = 'repository-imported'
      WHERE project_id = ? AND repository_id = ? AND phase = 'objects-installed'`).run(projectId, repositoryId);
    const imported = requireImport(database, projectId, repositoryId);
    if (imported.phase !== "repository-imported") {
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
    return database.prepare(`${selectSql} ORDER BY project_id, repository_id`).all().map(parseNativeProjectRootImportRow);
  } finally {
    database.close();
  }
}

function mutateImport<T>(
  databasePath: string,
  projectId: string,
  repositoryId: string,
  mutation: (database: DatabaseSync, existing: NativeProjectRootImport) => T
): T {
  const database = new DatabaseSync(databasePath, { defensive: true });
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    try {
      const result = mutation(database, requireImport(database, projectId, repositoryId));
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
  repositoryId: string,
  ownerHostId: string,
  selector: NativeProjectRootImportFinalizeSelector
): void {
  assertSelector(existing, projectId, repositoryId, selector);
  assertActivatedGeneration(database, selector.generationId);
  const registration = selectRegistration(database, projectId, repositoryId);
  if (registration === undefined || registration.phase !== "repository-prepared") {
    throw new NativeProjectRootImportStateError("native Project root import requires a prepared root");
  }
  if (existing.ownerHostId !== ownerHostId || registration.ownerHostId !== ownerHostId) {
    throw new NativeProjectRootImportOwnershipError();
  }
  if (registration.serviceId !== existing.serviceId
    || registration.repositoryId !== existing.repositoryId) {
    throw new NativeProjectRootImportConflictError(projectId);
  }
}

function assertSelector(
  existing: NativeProjectRootImport,
  projectId: string,
  repositoryId: string,
  selector: NativeProjectRootImportFinalizeSelector
): void {
  if (existing.projectId !== projectId || existing.repositoryId !== repositoryId || existing.generationId !== selector.generationId
    || existing.importNonce !== selector.importNonce || existing.bundleDigest !== selector.bundleDigest) {
    throw new NativeProjectRootImportConflictError(projectId);
  }
}

function requireImport(database: DatabaseSync, projectId: string, repositoryId: string): NativeProjectRootImport {
  const row = database.prepare(`${selectSql} WHERE project_id = ? AND repository_id = ?`).get(projectId, repositoryId);
  if (row === undefined) throw new NativeProjectRootImportConflictError(projectId);
  return parseNativeProjectRootImportRow(row);
}

function objectIdMatches(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}
