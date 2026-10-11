import { chmod, chown, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeNativeOrdinaryBundleState,
  inspectNativeOrdinaryBundleState,
  nativeOrdinaryBundleMarkerPath
} from "../../../../core/packages/core/src/nativeOrdinaryBundleState.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native ordinary bundle state filesystem safety", () => {
  it.each([
    ["state directory", async (root: string) => chmod(root, 0o755)],
    ["database", async (root: string) => chmod(join(root, "ordinary-ci.sqlite3"), 0o666)],
    ["marker", async (root: string) => chmod(nativeOrdinaryBundleMarkerPath(root), 0o666)]
  ])("rejects the wrong %s mode without repairing state", async (_label, arrange) => {
    // Given
    const root = await initializedRoot();
    await arrange(root);
    const before = await treeSnapshot(root);

    // When
    const inspection = inspectNativeOrdinaryBundleState(root);

    // Then
    await expect(inspection).rejects.toThrow(/mode/i);
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it.each(["ordinary-ci.sqlite3-wal", "ordinary-ci.sqlite3-shm"])(
    "rejects the wrong %s mode without repairing state",
    async (entry) => {
      // Given
      const root = await initializedRoot();
      const database = openWalDatabase(root);
      await chmod(join(root, entry), 0o666);
      const before = await treeSnapshot(root);

      // When
      const inspection = inspectNativeOrdinaryBundleState(root);

      // Then
      await expect(inspection).rejects.toThrow(/mode/i);
      expect(await treeSnapshot(root)).toEqual(before);
      database.close();
    }
  );

  it("rejects a hard-linked database without changing state", async () => {
    // Given
    const root = await initializedRoot();
    const database = join(root, "ordinary-ci.sqlite3");
    const alias = join(await temporaryRoot(), "database-link");
    await link(database, alias);
    const before = await treeSnapshot(root);

    // When
    const inspection = inspectNativeOrdinaryBundleState(root);

    // Then
    await expect(inspection).rejects.toThrow(/link/i);
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it("rejects a hard-linked marker without changing state", async () => {
    // Given
    const root = await initializedRoot();
    const marker = nativeOrdinaryBundleMarkerPath(root);
    const alias = join(await temporaryRoot(), "marker-link");
    await link(marker, alias);
    const before = await treeSnapshot(root);

    // When
    const inspection = inspectNativeOrdinaryBundleState(root);

    // Then
    await expect(inspection).rejects.toThrow(/link/i);
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it("rejects a state directory with an unexpected link without changing it", async () => {
    // Given
    const root = await initializedRoot();
    await mkdir(join(root, "unexpected-directory"), { mode: 0o700 });
    const beforeEntries = await readdir(root);
    const before = await stat(root, { bigint: true });

    // When
    const inspection = inspectNativeOrdinaryBundleState(root);

    // Then
    await expect(inspection).rejects.toThrow(/link/i);
    expect(await readdir(root)).toEqual(beforeEntries);
    expect(await stat(root, { bigint: true })).toEqual(before);
  });

  it.each(["ordinary-ci.sqlite3-wal", "ordinary-ci.sqlite3-shm"])(
    "rejects a hard-linked %s sidecar without changing state",
    async (entry) => {
      // Given
      const root = await initializedRoot();
      const database = openWalDatabase(root);
      const stateFile = join(root, entry);
      const alias = join(await temporaryRoot(), "sidecar-link");
      await link(stateFile, alias);
      const before = await treeSnapshot(root);

      // When
      const inspection = inspectNativeOrdinaryBundleState(root);

      // Then
      await expect(inspection).rejects.toThrow(/link/i);
      expect(await treeSnapshot(root)).toEqual(before);
      database.close();
    }
  );

  it("rejects a symlinked known state entry without reading its target", async () => {
    // Given
    const root = await initializedRoot();
    const marker = nativeOrdinaryBundleMarkerPath(root);
    const markerBytes = await readFile(marker);
    await rm(marker);
    const targetRoot = await temporaryRoot();
    const target = join(targetRoot, "foreign-marker");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(target, markerBytes, { mode: 0o444 }));
    await symlink(target, marker);
    const before = await treeSnapshot(root);

    // When
    const inspection = inspectNativeOrdinaryBundleState(root);

    // Then
    await expect(inspection).rejects.toThrow(/regular file|symlink/i);
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it.runIf(process.getuid?.() === 0)("rejects state owned by a foreign uid without changing it", async () => {
    // Given
    const root = await initializedRoot();
    const database = join(root, "ordinary-ci.sqlite3");
    await chown(database, 65_534, 65_534);
    const before = await treeSnapshot(root);

    // When
    const inspection = inspectNativeOrdinaryBundleState(root);

    // Then
    await expect(inspection).rejects.toThrow(/owned|owner/i);
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it.runIf(process.getuid?.() === 0)("rejects a state directory owned by a foreign uid without changing it", async () => {
    // Given
    const root = await initializedRoot();
    await chown(root, 65_534, 65_534);
    const before = await treeSnapshot(root);

    // When
    const inspection = inspectNativeOrdinaryBundleState(root);

    // Then
    await expect(inspection).rejects.toThrow(/owned|owner/i);
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it.runIf(process.getuid?.() === 0).each([
    "ordinary-ci.sqlite3-wal", "ordinary-ci.sqlite3-shm", "state-format.json"
  ])("rejects foreign ownership of %s without changing state", async (entry) => {
    // Given
    const root = await initializedRoot();
    const database = openWalDatabase(root);
    await chown(join(root, entry), 65_534, 65_534);
    const before = await treeSnapshot(root);

    // When
    const inspection = inspectNativeOrdinaryBundleState(root);

    // Then
    await expect(inspection).rejects.toThrow(/owned|owner/i);
    expect(await treeSnapshot(root)).toEqual(before);
    database.close();
  });
});

async function initializedRoot(): Promise<string> {
  const root = await temporaryRoot();
  await initializeNativeOrdinaryBundleState(root);
  return root;
}

function openWalDatabase(root: string): DatabaseSync {
  const database = new DatabaseSync(join(root, "ordinary-ci.sqlite3"));
  database.exec(`PRAGMA journal_mode = WAL;
    INSERT OR IGNORE INTO bundle_activation VALUES ('${"a".repeat(64)}', '${"b".repeat(64)}')`);
  return database;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-ordinary-bundle-safety-"));
  await chmod(root, 0o750);
  roots.push(root);
  return root;
}

async function treeSnapshot(root: string): Promise<readonly TreeEntry[]> {
  return Promise.all((await readdir(root)).sort().map(async (entry) => {
    const path = join(root, entry);
    const metadata = await stat(path, { bigint: true });
    return {
      entry,
      bytes: await readFile(path),
      mode: metadata.mode,
      uid: metadata.uid,
      links: metadata.nlink,
      mtimeNanoseconds: metadata.mtimeNs
    };
  }));
}

type TreeEntry = {
  readonly entry: string;
  readonly bytes: Buffer;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly links: bigint;
  readonly mtimeNanoseconds: bigint;
};
