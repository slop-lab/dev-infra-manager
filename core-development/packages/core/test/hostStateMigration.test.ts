import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertHostLifecycleSchema1 } from "../../../../core/packages/core/src/hostLifecycleRecord.js";
import { migrateHostLifecycleState } from "../../../../core/packages/core/src/hostStateMigration.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { HostLifecycleRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";

const SCHEMA_1 = {
  schemaVersion: 1,
  phase: "stopped",
  resumeWorkspaces: ["workspace"],
  resumeCiRunners: [{ project: "example", name: "capacity" }],
  resumeManagedContainers: ["managed-service"],
  updatedAt: "2026-09-21T00:00:00.000Z",
  error: "interrupted"
} as const;

const SCHEMA_2 = {
  schemaVersion: 2,
  phase: "stopped",
  resumeWorkspaces: ["workspace"],
  restartCiRunners: [{ project: "example", name: "capacity" }],
  resumeManagedContainers: ["managed-service"],
  updatedAt: "2026-09-21T00:00:00.000Z",
  error: "interrupted"
} as const;

const schema1Bytes = `${JSON.stringify(SCHEMA_1, null, 4)}\n`;
const schema2Bytes = `${JSON.stringify(SCHEMA_2, null, 2)}\n`;

describe("host lifecycle schema 1 migration", () => {
  let root: string;
  let state: LifecycleState;
  let canonical: string;
  let backup: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-host-migration-"));
    state = new LifecycleState(root);
    canonical = state.hostLifecyclePath();
    backup = join(root, "host.json.schema-1.bak");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("maps the only historical schema change without altering another field", () => {
    // Given / When
    const converted = convertHostLifecycleSchema1(SCHEMA_1);

    // Then
    expect(converted).toEqual(SCHEMA_2);
  });

  it.each([
    ["an extra top-level field", { ...SCHEMA_1, future: true }],
    ["the schema 2 runner key", { ...SCHEMA_1, resumeCiRunners: undefined, restartCiRunners: [] }],
    ["an extra runner field", { ...SCHEMA_1, resumeCiRunners: [{ project: "example", name: "capacity", future: true }] }],
    ["a malformed runner", { ...SCHEMA_1, resumeCiRunners: [{ project: "example" }] }],
    ["another schema", { ...SCHEMA_1, schemaVersion: 0 }]
  ])("rejects schema 1 with %s", (_case, record) => {
    // Given / When / Then
    expect(() => convertHostLifecycleSchema1(record)).toThrow();
  });

  it("creates a permanent byte-exact mode-0600 backup before replacing schema 1", async () => {
    // Given
    await writeFile(canonical, schema1Bytes, { mode: 0o640 });

    // When
    const result = await migrateHostLifecycleState(state);

    // Then
    expect(result).toEqual({ kind: "migrated" });
    expect(await readFile(backup, "utf8")).toBe(schema1Bytes);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(canonical, "utf8"))).toEqual(SCHEMA_2);
    expect((await stat(canonical)).mode & 0o777).toBe(0o600);
  });

  it("keeps normal lifecycle reads schema-2-only without mutating schema 1", async () => {
    // Given
    await writeFile(canonical, schema1Bytes);

    // When
    const read = state.readHostLifecycle();

    // Then
    await expect(read).rejects.toThrow();
    expect(await readFile(canonical, "utf8")).toBe(schema1Bytes);
  });

  it("finishes schema 1 migration when an identical permanent backup already exists", async () => {
    // Given
    await writeFile(canonical, schema1Bytes);
    await writeFile(backup, schema1Bytes, { mode: 0o600 });

    // When
    const result = await migrateHostLifecycleState(state);

    // Then
    expect(result).toEqual({ kind: "migrated" });
    expect(await readFile(backup, "utf8")).toBe(schema1Bytes);
    expect(JSON.parse(await readFile(canonical, "utf8"))).toEqual(SCHEMA_2);
  });

  it.each([false, true])("leaves valid schema 2 bytes unchanged with backup present=%s", async (withBackup) => {
    // Given
    await writeFile(canonical, schema2Bytes, { mode: 0o600 });
    if (withBackup) await writeFile(backup, schema1Bytes, { mode: 0o600 });

    // When
    const result = await migrateHostLifecycleState(state);

    // Then
    expect(result).toEqual({ kind: "unchanged" });
    expect(await readFile(canonical, "utf8")).toBe(schema2Bytes);
  });

  it("recovers an absent canonical record from a valid permanent backup", async () => {
    // Given
    await writeFile(backup, schema1Bytes, { mode: 0o600 });

    // When
    const result = await migrateHostLifecycleState(state);

    // Then
    expect(result).toEqual({ kind: "recovered" });
    expect(await readFile(backup, "utf8")).toBe(schema1Bytes);
    expect(JSON.parse(await readFile(canonical, "utf8"))).toEqual(SCHEMA_2);
  });

  it("removes recognized regular orphan temporaries only after validating canonical state", async () => {
    // Given
    await writeFile(canonical, schema2Bytes, { mode: 0o600 });
    const schema1Temporary = join(root, `host.json.schema-1.backup.tmp-${process.pid}-00000000-0000-4000-8000-000000000001`);
    const schema2Temporary = join(root, `host.json.schema-2.replace.tmp-${process.pid}-00000000-0000-4000-8000-000000000002`);
    const unrelated = join(root, "host.json.tmp-user");
    await writeFile(schema1Temporary, "partial", { mode: 0o600 });
    await writeFile(schema2Temporary, "partial", { mode: 0o600 });
    await writeFile(unrelated, "keep");

    // When
    await migrateHostLifecycleState(state);

    // Then
    expect(await readdir(root)).not.toContain(basename(schema1Temporary));
    expect(await readdir(root)).not.toContain(basename(schema2Temporary));
    expect(await readFile(unrelated, "utf8")).toBe("keep");
  });

  it.each([
    ["malformed canonical JSON", "{partial", undefined],
    ["unsupported canonical schema", JSON.stringify({ ...SCHEMA_2, schemaVersion: 3 }), undefined],
    ["extra-key schema 1", JSON.stringify({ ...SCHEMA_1, future: true }), undefined],
    ["extra-key schema 2", JSON.stringify({ ...SCHEMA_2, future: true }), undefined],
    ["conflicting backup", schema1Bytes, `${JSON.stringify({ ...SCHEMA_1, updatedAt: "different" })}\n`],
    ["malformed recovery backup", undefined, "{partial"],
    ["schema 2 in the schema 1 backup", undefined, schema2Bytes]
  ])("fails closed without mutation for %s", async (_case, canonicalBytes, backupBytes) => {
    // Given
    if (canonicalBytes !== undefined) await writeFile(canonical, canonicalBytes);
    if (backupBytes !== undefined) await writeFile(backup, backupBytes, { mode: 0o600 });
    const beforeCanonical = canonicalBytes;
    const beforeBackup = backupBytes;

    // When
    const migration = migrateHostLifecycleState(state);

    // Then
    await expect(migration).rejects.toThrow();
    if (beforeCanonical !== undefined) expect(await readFile(canonical, "utf8")).toBe(beforeCanonical);
    if (beforeBackup !== undefined) expect(await readFile(backup, "utf8")).toBe(beforeBackup);
  });

  it.each(["canonical", "backup", "temporary"] as const)("rejects a symlink at the %s artifact", async (artifact) => {
    // Given
    const outside = join(root, "outside");
    await writeFile(outside, schema1Bytes);
    if (artifact === "canonical") await symlink(outside, canonical);
    if (artifact === "backup") {
      await writeFile(canonical, schema1Bytes);
      await symlink(outside, backup);
    }
    if (artifact === "temporary") {
      await writeFile(canonical, schema2Bytes);
      await symlink(
        outside,
        join(root, `host.json.schema-2.replace.tmp-${process.pid}-00000000-0000-4000-8000-000000000003`)
      );
    }

    // When / Then
    await expect(migrateHostLifecycleState(state)).rejects.toThrow(/regular file|symlink|unsafe/i);
    expect((await lstat(outside)).isFile()).toBe(true);
  });

  it.each(["canonical", "backup", "temporary"] as const)("rejects a non-regular %s artifact", async (artifact) => {
    // Given
    if (artifact === "canonical") await mkdir(canonical);
    if (artifact === "backup") {
      await writeFile(canonical, schema1Bytes);
      await mkdir(backup);
    }
    if (artifact === "temporary") {
      await writeFile(canonical, schema2Bytes);
      await mkdir(join(root, `host.json.schema-1.backup.tmp-${process.pid}-00000000-0000-4000-8000-000000000004`));
    }

    // When / Then
    await expect(migrateHostLifecycleState(state)).rejects.toThrow(/regular file/);
  });

  it("rejects a recognized temporary whose mode is not 0600", async () => {
    // Given
    await writeFile(canonical, schema2Bytes, { mode: 0o600 });
    const temporary = join(root, `host.json.schema-2.replace.tmp-${process.pid}-00000000-0000-4000-8000-000000000005`);
    await writeFile(temporary, "partial", { mode: 0o600 });
    await chmod(temporary, 0o640);

    // When / Then
    await expect(migrateHostLifecycleState(state)).rejects.toThrow(/0600/);
    expect(await readFile(temporary, "utf8")).toBe("partial");
  });

  it("rejects a backup whose mode is not 0600 without changing it", async () => {
    // Given
    await writeFile(canonical, schema2Bytes, { mode: 0o600 });
    await writeFile(backup, schema1Bytes, { mode: 0o600 });
    await chmod(backup, 0o640);

    // When / Then
    await expect(migrateHostLifecycleState(state)).rejects.toThrow(/0600/);
    expect((await stat(backup)).mode & 0o777).toBe(0o640);
  });

  it("is idempotent after migration and preserves the permanent backup", async () => {
    // Given
    await writeFile(canonical, schema1Bytes);
    await migrateHostLifecycleState(state);
    const canonicalAfterFirst = await readFile(canonical, "utf8");

    // When
    const second = await migrateHostLifecycleState(state);

    // Then
    expect(second).toEqual({ kind: "unchanged" });
    expect(await readFile(canonical, "utf8")).toBe(canonicalAfterFirst);
    expect(await readFile(backup, "utf8")).toBe(schema1Bytes);
  });

  it("accepts lifecycle evolution after migration without changing canonical bytes or the backup", async () => {
    // Given
    await writeFile(canonical, schema1Bytes);
    await migrateHostLifecycleState(state);
    const evolved: HostLifecycleRecord = {
      schemaVersion: 2,
      phase: "ready",
      resumeWorkspaces: [],
      restartCiRunners: [],
      resumeManagedContainers: [],
      updatedAt: "2026-09-23T00:00:00.000Z"
    };
    await state.writeHostLifecycle(evolved);
    const canonicalAfterEvolution = await readFile(canonical, "utf8");

    // When
    const result = await migrateHostLifecycleState(state);

    // Then
    expect(result).toEqual({ kind: "unchanged" });
    expect(await readFile(canonical, "utf8")).toBe(canonicalAfterEvolution);
    expect(await readFile(backup, "utf8")).toBe(schema1Bytes);
  });
});
