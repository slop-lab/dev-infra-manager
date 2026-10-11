import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeNativeOrdinaryBundleState,
  inspectNativeOrdinaryBundleState
} from "../../../../core/packages/core/src/nativeOrdinaryBundleState.js";
import { assertNativeRootCiEventReceiptIntegrity } from "../../../../core/packages/core/src/nativeRootCiEventReceiptIntegrity.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native root CI event receipt integrity", () => {
  it("rejects malformed receipt semantics during read-only check-state", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-receipt-integrity-"));
    roots.push(root);
    await chmod(root, 0o750);
    const state = await initializeNativeOrdinaryBundleState(root);
    const database = new DatabaseSync(state.database);
    database.exec(`
      INSERT INTO native_root_admissions VALUES (
        '00000000-0000-4000-8000-000000000001', '${"a".repeat(64)}', 'ordinary-main', '${"b".repeat(64)}',
        'native-main', 'project-a', 'root', '00000000-0000-4000-8000-000000000002', 0,
        'refs/heads/main', '${"1".repeat(40)}', '${"2".repeat(40)}', '${"c".repeat(64)}', '{}',
        '${"d".repeat(64)}', 2000, 'active', 1000, 1000, NULL);
      INSERT INTO native_root_ci_event_receipts VALUES (
        '00000000-0000-4000-8000-000000000001', '${"e".repeat(64)}', 'sha256:${"f".repeat(64)}', '{}',
        'ordinary-main', '${"b".repeat(64)}', 'native-main', 'project-a', 'root',
        '00000000-0000-4000-8000-000000000002', '${"c".repeat(64)}', 0, 'refs/heads/main',
        '${"1".repeat(40)}', '${"2".repeat(40)}', '${"d".repeat(64)}', 1000);
    `);
    database.close();

    // When / Then
    await expect(inspectNativeOrdinaryBundleState(root)).rejects.toThrow(/receipt state is invalid/i);
  });

  it("rejects more than the permanent receipt cap before semantic iteration", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-receipt-cap-integrity-"));
    roots.push(root);
    await chmod(root, 0o750);
    const state = await initializeNativeOrdinaryBundleState(root);
    const database = new DatabaseSync(state.database);
    database.exec(`
      INSERT INTO native_root_admissions VALUES (
        '00000000-0000-4000-8000-000000000001', '${"a".repeat(64)}', 'ordinary-main', '${"b".repeat(64)}',
        'native-main', 'project-a', 'root', '00000000-0000-4000-8000-000000000002', 0,
        'refs/heads/main', '${"1".repeat(40)}', '${"2".repeat(40)}', '${"c".repeat(64)}', '{}',
        '${"d".repeat(64)}', 2000, 'active', 1000, 1000, NULL);
      WITH RECURSIVE values_(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM values_ WHERE value < 100000)
      INSERT INTO native_root_ci_event_receipts SELECT
        '00000000-0000-4000-8000-000000000001', printf('%064x', value),
        'sha256:${"f".repeat(64)}', '{}', 'ordinary-main', '${"b".repeat(64)}', 'native-main', 'project-a',
        'root', '00000000-0000-4000-8000-000000000002', '${"c".repeat(64)}', 0, 'refs/heads/main',
        '${"1".repeat(40)}', '${"2".repeat(40)}', '${"d".repeat(64)}', 1000 FROM values_;
    `);
    database.close();

    // When / Then
    await expect(inspectNativeOrdinaryBundleState(root)).rejects.toThrow(/receipt state is invalid/i);
  });

  it("rejects a receipt whose admission row is missing", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-receipt-orphan-"));
    roots.push(root);
    await chmod(root, 0o750);
    const state = await initializeNativeOrdinaryBundleState(root);
    const database = new DatabaseSync(state.database);
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare(`INSERT INTO native_root_ci_event_receipts VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, 'root', ?, ?, 0, ?, ?, ?, ?, 1000)`).run(
      "00000000-0000-4000-8000-000000000001", "e".repeat(64), `sha256:${"f".repeat(64)}`, "{}",
      "ordinary-main", "b".repeat(64), "native-main", "project-a",
      "00000000-0000-4000-8000-000000000002", "c".repeat(64), "refs/heads/main",
      "1".repeat(40), "2".repeat(40), "d".repeat(64));
    database.close();

    // When / Then
    expect(() => assertNativeRootCiEventReceiptIntegrity(state.database)).toThrow(/receipt state is invalid/i);
    await expect(inspectNativeOrdinaryBundleState(root)).rejects.toThrow(/database integrity check failed/i);
  });
});
