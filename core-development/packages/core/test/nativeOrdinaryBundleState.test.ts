import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectNativeOrdinaryBundleState,
  initializeNativeOrdinaryBundleState,
  nativeOrdinaryBundleMarkerPath
} from "../../../../core/packages/core/src/nativeOrdinaryBundleState.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native ordinary bundle state", () => {
  it("creates a durable schema-3 database bound to its exact schema manifest", async () => {
    // Given
    const root = await temporaryStateRoot();

    // When
    const initialized = await initializeNativeOrdinaryBundleState(root);

    // Then
    expect(initialized).toEqual({ database: join(root, "ordinary-ci.sqlite3"), stateFormat: 3 });
    const marker: unknown = JSON.parse(await readFile(nativeOrdinaryBundleMarkerPath(root), "utf8"));
    expect(marker).toEqual({
      schemaVersion: 1,
      stateFormat: 3,
      database: "ordinary-ci.sqlite3",
      schemaManifestSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });
    const database = new DatabaseSync(initialized.database, { readOnly: true });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'bundle_activation'").get())
      .toEqual({ name: "bundle_activation" });
    database.close();
    expect((await stat(root)).mode & 0o777).toBe(0o750);
    expect((await stat(initialized.database)).mode & 0o777).toBe(0o600);
    expect((await stat(nativeOrdinaryBundleMarkerPath(root))).mode & 0o777).toBe(0o444);
  });

  it("does not adopt an existing database when its bundle marker is absent", async () => {
    // Given
    const root = await temporaryStateRoot();
    const databasePath = join(root, "ordinary-ci.sqlite3");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA user_version = 3");
    database.close();
    const before = await treeSnapshot(root);

    // When
    const initialize = initializeNativeOrdinaryBundleState(root);

    // Then
    await expect(initialize).rejects.toThrow(/marker.*missing/i);
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it("rejects the prior generation-only format-3 state without changing any target byte", async () => {
    // Given
    const root = await temporaryStateRoot();
    await initializeNativeOrdinaryBundleState(root);
    const database = new DatabaseSync(join(root, "ordinary-ci.sqlite3"));
    database.exec(`
      ALTER TABLE bundle_activation RENAME TO replaced_bundle_activation;
      CREATE TABLE bundle_activation (
        slot INTEGER PRIMARY KEY CHECK(slot = 1),
        generation_id TEXT NOT NULL CHECK(length(generation_id) = 64 AND generation_id NOT GLOB '*[^0-9a-f]*')
      ) STRICT;
      DROP TABLE replaced_bundle_activation;
      PRAGMA journal_mode = DELETE;
    `);
    database.close();
    const markerPath = nativeOrdinaryBundleMarkerPath(root);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await chmod(markerPath, 0o644);
    await writeFile(markerPath, `${JSON.stringify({
      ...marker,
      schemaManifestSha256: "sha256:6508f742ed30846663c5404b2cec50da1fa4bbfa69850eab63d9ebafb4fffd0c"
    })}\n`);
    await chmod(markerPath, 0o444);
    const before = await treeSnapshot(root);

    // When
    const inspect = inspectNativeOrdinaryBundleState(root);

    // Then
    await expect(inspect).rejects.toThrow(/schema manifest/i);
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it.each([
    ["schema 2", async (root: string) => {
      await initializeNativeOrdinaryBundleState(root);
      const database = new DatabaseSync(join(root, "ordinary-ci.sqlite3"));
      database.exec("PRAGMA user_version = 2");
      database.close();
    }, /schema manifest|state format/i],
    ["a mismatched marker", async (root: string) => {
      await initializeNativeOrdinaryBundleState(root);
      const markerPath = nativeOrdinaryBundleMarkerPath(root);
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      await chmod(markerPath, 0o644);
      await writeFile(markerPath, `${JSON.stringify({ ...marker, schemaManifestSha256: `sha256:${"0".repeat(64)}` })}\n`);
      await chmod(markerPath, 0o444);
    }, /schema manifest/i],
    ["unknown state", async (root: string) => {
      await initializeNativeOrdinaryBundleState(root);
      await writeFile(join(root, "foreign-state"), "unexpected");
    }, /unknown ordinary CI state/i]
  ])("rejects %s without changing any target byte or mtime", async (_label, arrange, message) => {
    // Given
    const root = await temporaryStateRoot();
    await arrange(root);
    const before = await treeSnapshot(root);

    // When
    const inspect = inspectNativeOrdinaryBundleState(root);

    // Then
    await expect(inspect).rejects.toThrow(message);
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it("inspects a WAL database without creating target SHM or changing target bytes", async () => {
    // Given
    const source = await temporaryStateRoot();
    await initializeNativeOrdinaryBundleState(source);
    const sourceDatabase = new DatabaseSync(join(source, "ordinary-ci.sqlite3"));
    sourceDatabase.exec(`PRAGMA journal_mode = WAL;
      INSERT INTO bundle_activation(generation_id, activation_token_sha256)
      VALUES ('${"a".repeat(64)}', '${"b".repeat(64)}')`);
    const root = await temporaryStateRoot();
    await Promise.all([
      copyBytes(join(source, "ordinary-ci.sqlite3"), join(root, "ordinary-ci.sqlite3"), 0o600),
      copyBytes(join(source, "ordinary-ci.sqlite3-wal"), join(root, "ordinary-ci.sqlite3-wal"), 0o600),
      copyBytes(nativeOrdinaryBundleMarkerPath(source), nativeOrdinaryBundleMarkerPath(root), 0o444)
    ]);
    sourceDatabase.close();
    const before = await treeSnapshot(root);

    // When
    const result = await inspectNativeOrdinaryBundleState(root);

    // Then
    expect(result).toEqual({ stateFormat: 3 });
    expect(await treeSnapshot(root)).toEqual(before);
    expect(await readdir(root)).not.toContain("ordinary-ci.sqlite3-shm");
  });
});

async function temporaryStateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-ordinary-bundle-state-"));
  await chmod(root, 0o750);
  roots.push(root);
  return root;
}

async function copyBytes(source: string, destination: string, mode: number): Promise<void> {
  await writeFile(destination, await readFile(source), { mode });
  await chmod(destination, mode);
}

async function treeSnapshot(root: string): Promise<readonly TreeEntry[]> {
  const entries = await readdir(root);
  return Promise.all(entries.sort().map(async (entry) => {
    const path = join(root, entry);
    const metadata = await stat(path, { bigint: true });
    const bytes = await readFile(path);
    return {
      entry,
      mode: metadata.mode,
      mtimeNanoseconds: metadata.mtimeNs,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }));
}

type TreeEntry = {
  readonly entry: string;
  readonly mode: bigint;
  readonly mtimeNanoseconds: bigint;
  readonly sha256: string;
};
