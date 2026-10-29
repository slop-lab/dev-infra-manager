import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { assertStateSchema, initializeStateSchema } from "./state-schema.js";

export async function openStateDatabase(path: string, createState: boolean): Promise<DatabaseSync> {
  const file = createState
    ? await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    : await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const identity = await file.stat({ bigint: true });
    const uid = process.getuid?.();
    if (uid === undefined || !identity.isFile() || identity.nlink !== 1n
      || identity.uid !== BigInt(uid) || (identity.mode & 0o777n) !== 0o600n) {
      throw new RepositoryStateError("repository state must be a caller-owned mode-0600 regular file");
    }
  } finally {
    await file.close();
  }
  const database = new DatabaseSync(path, { defensive: true, timeout: 0 });
  try {
    database.exec("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA trusted_schema=OFF");
    if (createState) initializeStateSchema(database);
    assertStateSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function initializeAuthorityEpoch(database: DatabaseSync, epoch: string, refPolicyRevision: string): void {
  transaction(database, () => {
    database.prepare("INSERT INTO authority_epoch(authority_epoch,ref_policy_revision) VALUES(?,?)").run(epoch, refPolicyRevision);
    database.prepare("UPDATE service_metadata SET current_authority_epoch=? WHERE singleton=1").run(epoch);
  });
}

export function transaction<Result>(database: DatabaseSync, operation: () => Result): Result {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export class RepositoryStateError extends Error {
  readonly name = "RepositoryStateError";
}
