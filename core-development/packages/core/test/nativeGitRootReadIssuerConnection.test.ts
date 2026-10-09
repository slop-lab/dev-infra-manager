import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNativeGitRootReadIssuerConnection,
  NativeGitRootReadIssuerConnectionError,
  parseNativeGitRootReadIssuerConnection
} from "../../../../core/packages/core/src/nativeGitRootReadIssuerConnection.js";

const roots: string[] = [];
const valid = {
  schemaVersion: 1, endpoint: "http://127.0.0.1:8080", serviceId: "native-main",
  role: "operator-root-read-issuer", hostId: "host-a", generationId: "a".repeat(64),
  credential: { username: "project-root-read-issuer-a", password: Buffer.alloc(32, 61).toString("base64url") }
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Git root read issuer connection", () => {
  it("parses only the exact issuer role, owner, service, generation, and loopback origin", () => {
    expect(parseNativeGitRootReadIssuerConnection(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, role: "operator-root-importer" },
      { ...valid, hostId: "Host A" },
      { ...valid, serviceId: "native-other" },
      { ...valid, generationId: "b".repeat(63) },
      { ...valid, endpoint: "http://192.0.2.1:8080" },
      { ...valid, endpoint: "http://127.0.0.1:8080/v1" },
      { ...valid, credential: { ...valid.credential, password: "wrong" } },
      { ...valid, added: "unexpected" }
    ]) {
      expect(() => parseNativeGitRootReadIssuerConnection(invalid))
        .toThrow(NativeGitRootReadIssuerConnectionError);
    }
  });

  it("reads only a mode-0600 owner-only single-link regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-root-read-issuer-connection-"));
    roots.push(root);
    const path = join(root, "issuer.json");
    await writeFile(path, JSON.stringify(valid), { mode: 0o600 });
    expect(await loadNativeGitRootReadIssuerConnection(path)).toEqual(valid);

    const alias = join(root, "alias.json");
    await symlink(path, alias);
    await expect(loadNativeGitRootReadIssuerConnection(alias))
      .rejects.toThrow(NativeGitRootReadIssuerConnectionError);

    const hardlink = join(root, "hardlink.json");
    await link(path, hardlink);
    await expect(loadNativeGitRootReadIssuerConnection(path))
      .rejects.toThrow(NativeGitRootReadIssuerConnectionError);
  });

  it("refuses a group-readable issuer secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-root-read-issuer-permissions-"));
    roots.push(root);
    const path = join(root, "issuer.json");
    await writeFile(path, JSON.stringify(valid), { mode: 0o640 });
    await chmod(path, 0o640);
    await expect(loadNativeGitRootReadIssuerConnection(path))
      .rejects.toThrow(NativeGitRootReadIssuerConnectionError);
  });
});
