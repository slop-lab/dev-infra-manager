import { constants } from "node:fs";
import { copyFile, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const executionStateFormat = 102;
export const executionDatabaseName = "executions.sqlite3";
const entries = new Set([executionDatabaseName, `${executionDatabaseName}-wal`, `${executionDatabaseName}-shm`]);
export async function inspectExecutionState(directory: string): Promise<{ readonly stateFormat: 102 }> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("CI state path must be a directory");
  const names = await readdir(directory);
  if (!names.includes(executionDatabaseName) || names.some((name) => !entries.has(name))) {
    throw new Error("CI state is unsupported; select a fresh CI state directory");
  }
  const snapshot = await mkdtemp(join(tmpdir(), "dim-ci-inspect-"));
  try {
    for (const name of names.filter((name) => !name.endsWith("-shm"))) {
      const path = join(directory, name), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("CI state file is not owned");
      await copyFile(path, join(snapshot, name), constants.COPYFILE_EXCL);
    }
    const database = new DatabaseSync(join(snapshot, executionDatabaseName));
    try { assertExecutionDatabase(database); } finally { database.close(); }
    return { stateFormat: executionStateFormat };
  } finally { await rm(snapshot, { recursive: true, force: true }); }
}
export function assertExecutionDatabase(database: DatabaseSync): void {
  if (database.prepare("PRAGMA user_version").get()?.user_version !== executionStateFormat
    || database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("CI state is invalid");
  database.prepare("SELECT id,event_id,generation_id,phase,retry_of,worker_id,slot_id,request_id,created_at,execution_kind,publication,lease_expires_at,body FROM executions LIMIT 0").all();
  const names = database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((row) => row.name);
  if (names.join(",") !== "executions,metadata") throw new Error("CI database schema is unsupported");
}
