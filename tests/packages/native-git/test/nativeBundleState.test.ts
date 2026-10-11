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
  it("initializes truthful schema-8 state without writer authority and inspects it without mutation", async () => {
    // Given
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    await state.owner.release();
    const before = await stateTree(root);

    // When
    const result = await inspectNativeGitBundleState(root);

    // Then
    expect(result).toEqual({ stateFormat: 8 });
    expect(await stateTree(root)).toEqual(before);
    expect(before.map((entry) => entry.entry)).toEqual([
      ".dim-native-git-owner.sqlite3",
      "native-idle.sqlite3",
      "state-format.json"
    ]);
    expect(JSON.parse(await readFile(join(root, "state-format.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      stateFormat: 8,
      database: "native-idle.sqlite3",
      schemaManifestSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"), { readOnly: true });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
    expect(database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all()).toEqual([
      { name: "bundle_activation" },
      { name: "native_project_registration" },
      { name: "native_project_root_import" },
      { name: "native_project_root_promotion_finalized" },
      { name: "native_project_root_promotion_intent" }
    ]);
    database.close();
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

  it("rejects obsolete format-7 state without changing it", async () => {
    // Given
    const root = await temporaryRoot();
    const state = await initializeNativeGitBundleState(root);
    await state.owner.release();
    const database = new DatabaseSync(join(root, "native-idle.sqlite3"));
    database.exec("PRAGMA user_version = 7;");
    database.close();
    const markerPath = join(root, "state-format.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    await replaceMarker(root, `${JSON.stringify({
      ...marker,
      stateFormat: 7,
      schemaManifestSha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    })}\n`);
    const before = await stateTree(root);

    // When / Then
    await expect(inspectNativeGitBundleState(root)).rejects.toThrow(/marker|schema/i);
    await expect(initializeNativeGitBundleState(root)).rejects.toThrow(/marker|schema/i);
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
