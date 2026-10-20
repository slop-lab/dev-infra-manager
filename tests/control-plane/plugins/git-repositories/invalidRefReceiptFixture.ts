import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
/** Preserve the Git head and record payload while corrupting its durable identity. */
export function corruptRefReceipt(root: string): void {
  const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
  try { const result = database.prepare("UPDATE repository_ref_transition SET transition_id=? WHERE project_id='project-a' AND repository_id='root'").run("f".repeat(64)); if (result.changes !== 1) throw new Error("expected one repository ref receipt"); }
  finally { database.close(); }
}
