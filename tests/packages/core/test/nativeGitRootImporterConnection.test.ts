import { execFile } from "node:child_process";
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNativeGitRootImporterConnection,
  parseNativeGitRootImporterConnection,
  NativeGitRootImporterConnectionError
} from "../../../../core/packages/managed/src/nativeGitRootImporterConnection.js";

const roots: string[] = [];
const run = promisify(execFile);
const valid = {
  schemaVersion: 1, endpoint: "http://127.0.0.1:8080", serviceId: "native-main",
  role: "operator-root-importer", hostId: "host-a", generationId: "a".repeat(64),
  credential: { username: "root-importer-a", password: Buffer.alloc(32, 60).toString("base64url") }
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Git root importer connection", () => {
  it("parses only an exact importer identity and loopback HTTP origin", () => {
    expect(parseNativeGitRootImporterConnection(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, role: "operator-project-registrar" },
      { ...valid, endpoint: "http://192.0.2.1:8080" },
      { ...valid, endpoint: "http://127.0.0.1:8080/v1" },
      { ...valid, endpoint: "http://127.0.0.1:8080/" },
      { ...valid, credential: { ...valid.credential, password: "wrong" } },
      { ...valid, added: "unexpected" }
    ]) {
      expect(() => parseNativeGitRootImporterConnection(invalid)).toThrow(NativeGitRootImporterConnectionError);
    }
  });

  it("reads a mode-0600 owner-only file and refuses symlinks and hardlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-root-importer-connection-"));
    roots.push(root);
    const path = join(root, "importer.json");
    await writeFile(path, JSON.stringify(valid), { mode: 0o600 });
    expect(await loadNativeGitRootImporterConnection(path)).toEqual(valid);

    const alias = join(root, "alias.json");
    await symlink(path, alias);
    await expect(loadNativeGitRootImporterConnection(alias)).rejects.toThrow(NativeGitRootImporterConnectionError);

    const hardlink = join(root, "hardlink.json");
    await link(path, hardlink);
    await expect(loadNativeGitRootImporterConnection(path)).rejects.toThrow(NativeGitRootImporterConnectionError);
  });

  it("refuses group-readable files", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-root-importer-permissions-"));
    roots.push(root);
    const path = join(root, "importer.json");
    await writeFile(path, JSON.stringify(valid), { mode: 0o640 });
    await chmod(path, 0o640);
    await expect(loadNativeGitRootImporterConnection(path)).rejects.toThrow(NativeGitRootImporterConnectionError);
  });

  it("rejects duplicate JSON keys without changing the connection file", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-root-importer-duplicate-"));
    roots.push(root);
    const path = join(root, "importer.json");
    const bytes = Buffer.from(JSON.stringify(valid).replace('"hostId":"host-a"',
      '"hostId":"host-b","hostId":"host-a"'));
    await writeFile(path, bytes, { mode: 0o600 });

    // When / Then
    await expect(loadNativeGitRootImporterConnection(path)).rejects.toThrow(NativeGitRootImporterConnectionError);
    expect(await readFile(path)).toEqual(bytes);
  });

  it("rejects an owner-mode FIFO without blocking", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-root-importer-fifo-"));
    roots.push(root);
    const path = join(root, "importer.json");
    await run("/usr/bin/mkfifo", [path]);
    await chmod(path, 0o600);
    const moduleUrl = pathToFileURL(join(import.meta.dirname,
      "../../../../core/packages/managed/dist/nativeGitRootImporterConnection.js")).href;

    // When
    const child = run(process.execPath, ["--input-type=module", "-e", `
      const { loadNativeGitRootImporterConnection } = await import(process.env.DIM_TEST_MODULE);
      await loadNativeGitRootImporterConnection(process.env.DIM_TEST_PATH).then(
        () => process.exit(1),
        () => process.exit(0),
      );
    `], { env: { ...process.env, DIM_TEST_MODULE: moduleUrl, DIM_TEST_PATH: path }, timeout: 1_000 });

    // Then
    await expect(child).resolves.toMatchObject({ stdout: "", stderr: "" });
  });
});
