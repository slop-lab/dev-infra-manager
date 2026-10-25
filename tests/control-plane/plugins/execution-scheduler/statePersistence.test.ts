import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { executionSchema } from "../../../../packages/contracts/ci/src/aggregate.js";
import { inspectExecutionState } from "../../../../packages/control-plane/plugins/execution-scheduler/src/state.js";
import { ExecutionStore } from "../../../../packages/control-plane/plugins/execution-scheduler/src/store.js";
import { event, generation, slot } from "../../../contracts/ci/executionFixture.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function statePath(): Promise<{ readonly root: string; readonly databasePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "dim-execution-state-"));
  roots.push(root);
  return { root, databasePath: join(root, "executions.sqlite3") };
}

function parseFormat102Execution(value: unknown) {
  const execution = executionSchema.parse(value);
  if (execution.admission !== undefined) throw new Error("format-102 execution contains admission metadata");
  return execution;
}

it("keeps the exact format-102 schema and execution body while joining durable admission metadata", async () => {
  // Given
  const { root, databasePath } = await statePath();
  const first = new ExecutionStore(databasePath, generation, 30_000);
  const queued = first.enqueue(event());
  const assigned = first.reserve("worker-a", slot, randomUUID());
  if (assigned === undefined) throw new Error("expected assignment");

  // When
  first.releaseAdmission(assigned.id, { phase: "authorize", code: "timeout" });
  first.database.prepare("INSERT INTO metadata(key,value) VALUES (?,?)")
    .run("other-plugin/state/v1", JSON.stringify({ preserved: true }));

  // Then
  expect(first.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 102 });
  expect(first.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()).toEqual([
    { name: "executions" }, { name: "metadata" }
  ]);
  expect(first.database.prepare("SELECT name FROM pragma_table_info('executions') ORDER BY cid").all()).toEqual([
    { name: "id" }, { name: "event_id" }, { name: "generation_id" }, { name: "phase" }, { name: "retry_of" },
    { name: "worker_id" }, { name: "slot_id" }, { name: "request_id" }, { name: "created_at" },
    { name: "execution_kind" }, { name: "publication" }, { name: "lease_expires_at" }, { name: "body" }
  ]);
  expect(first.database.prepare("SELECT name FROM pragma_table_info('metadata') ORDER BY cid").all())
    .toEqual([{ name: "key" }, { name: "value" }]);
  const row = first.database.prepare("SELECT body FROM executions WHERE id=?").get(queued.id);
  expect(row).toBeDefined();
  const body = JSON.parse(String(row?.body));
  expect(parseFormat102Execution(body)).not.toHaveProperty("admission");
  expect(first.recentSummaries()[0]).toMatchObject({ id: queued.id, admission: { phase: "authorize", code: "timeout" } });
  first.close();

  const second = new ExecutionStore(databasePath, generation, 30_000);
  try {
    expect(second.recentSummaries()[0]).toMatchObject({ id: queued.id, admission: { phase: "authorize", code: "timeout" } });
    expect(second.database.prepare("SELECT value FROM metadata WHERE key=?").get("other-plugin/state/v1"))
      .toEqual({ value: JSON.stringify({ preserved: true }) });
  } finally { second.close(); }
  await expect(inspectExecutionState(root)).resolves.toEqual({ stateFormat: 102 });
});

it("refuses format 103 without changing it", async () => {
  // Given
  const { root, databasePath } = await statePath();
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE marker(value TEXT NOT NULL); INSERT INTO marker VALUES ('unchanged'); PRAGMA user_version=103;");
  database.close();
  const before = await readFile(databasePath);

  // When / Then
  expect(() => new ExecutionStore(databasePath, generation, 30_000)).toThrow("unsupported");
  await expect(inspectExecutionState(root)).rejects.toThrow();
  expect(await readFile(databasePath)).toEqual(before);
  const retained = new DatabaseSync(databasePath, { readOnly: true });
  try {
    expect(retained.prepare("PRAGMA user_version").get()).toEqual({ user_version: 103 });
    expect(retained.prepare("SELECT value FROM marker").get()).toEqual({ value: "unchanged" });
  } finally { retained.close(); }
});
