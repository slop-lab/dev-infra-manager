import { chmod, copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeNativeGitBundleState,
  inspectNativeGitBundleState
} from "../../../../core/packages/native-git/src/native-bundle-state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Git idle bundle state", () => {
  it("initializes truthful schema-3 state and inspects it without changing bytes or mtimes", async () => {
    // Given
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    await state.owner.release();
    const before = await stateTree(root);

    // When
    const result = await inspectNativeGitBundleState(root);

    // Then
    expect(result).toEqual({ stateFormat: 3 });
    expect(await stateTree(root)).toEqual(before);
    expect(before.map((entry) => entry.entry)).toEqual([
      ".dim-native-git-owner.sqlite3",
      "native-idle.sqlite3",
      "state-format.json"
    ]);
    expect((await stat(join(root, "state-format.json"))).mode & 0o777).toBe(0o444);
  });

  it.each([
    ["legacy state", async (root: string) => replaceMarker(root, '{"stateFormat":2}\n')],
    ["malformed state", async (root: string) => replaceMarker(root, "{\n")],
    ["an unknown entry", async (root: string) => writeFile(join(root, "project-a.git"), "foreign\n")]
  ])("rejects %s without changing it", async (_label, arrange) => {
    // Given
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    await state.owner.release();
    await arrange(root);
    const before = await stateTree(root);

    // When / Then
    await expect(inspectNativeGitBundleState(root)).rejects.toThrow();
    expect(await stateTree(root)).toEqual(before);
  });

  it("rejects the prior generation-only format-3 state without changing it", async () => {
    // Given
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    await state.owner.release();
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
    database.exec(`
      ALTER TABLE bundle_activation RENAME TO replaced_bundle_activation;
      CREATE TABLE bundle_activation (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        generation_id TEXT NOT NULL CHECK (length(generation_id) = 64)
      ) STRICT;
      DROP TABLE replaced_bundle_activation;
    `);
    database.close();
    const markerPath = join(root, "state-format.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await replaceMarker(root, `${JSON.stringify({
      ...marker,
      schemaManifestSha256: "sha256:5671688bf2382c8b74fef5365bc313251c625c636a65434e6ab4abe4177473ad"
    })}\n`);
    const before = await stateTree(root);

    // When
    const inspect = inspectNativeGitBundleState(root);

    // Then
    await expect(inspect).rejects.toThrow(/marker|schema/i);
    expect(await stateTree(root)).toEqual(before);
  });

  it("rejects owner state copied from another volume", async () => {
    // Given
    const source = await temporaryRoot();
    const sourceState = await initializeNativeGitBundleState(source);
    await sourceState.owner.release();
    const target = await temporaryRoot();
    await Promise.all((await readdir(source)).map((entry) => copyFile(join(source, entry), join(target, entry))));
    const before = await stateTree(target);

    // When / Then
    await expect(inspectNativeGitBundleState(target)).rejects.toThrow(/different storage root/i);
    expect(await stateTree(target)).toEqual(before);
  });

  it("retains exclusive service ownership after initialization", async () => {
    // Given
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);

    // When / Then
    await expect(initializeNativeGitBundleState(root)).rejects.toThrow(/active server/i);
    await state.owner.release();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-idle-state-"));
  roots.push(root);
  return root;
}

async function stateTree(root: string): Promise<readonly StateTreeEntry[]> {
  return Promise.all((await readdir(root)).sort().map(async (entry) => {
    const path = join(root, entry);
    const metadata = await stat(path, { bigint: true });
    return { entry, bytes: await readFile(path), mtimeNanoseconds: metadata.mtimeNs };
  }));
}

type StateTreeEntry = {
  readonly entry: string;
  readonly bytes: Buffer;
  readonly mtimeNanoseconds: bigint;
};

async function replaceMarker(root: string, value: string): Promise<void> {
  const marker = join(root, "state-format.json");
  await chmod(marker, 0o600);
  await writeFile(marker, value);
  await chmod(marker, 0o444);
}
