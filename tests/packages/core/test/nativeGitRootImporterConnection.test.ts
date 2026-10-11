import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNativeGitRootImporterConnection,
  parseNativeGitRootImporterConnection,
  NativeGitRootImporterConnectionError
} from "../../../../core/packages/core/src/nativeGitRootImporterConnection.js";

const roots: string[] = [];
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
});
