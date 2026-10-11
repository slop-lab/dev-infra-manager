import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNativeGitWorkspaceWriteIssuerConnection,
  NativeGitWorkspaceWriteIssuerConnectionError,
  parseNativeGitWorkspaceWriteIssuerConnection
} from "../../../../core/packages/core/src/nativeGitWorkspaceWriteIssuerConnection.js";

const roots: string[] = [];
const valid = {
  schemaVersion: 1,
  endpoint: "http://127.0.0.1:8080",
  serviceId: "native-main",
  role: "operator-workspace-write-issuer",
  hostId: "host-a",
  generationId: "a".repeat(64),
  credential: {
    username: "workspace-write-issuer-a",
    password: Buffer.alloc(32, 61).toString("base64url")
  }
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Git workspace write issuer connection", () => {
  it("parses only the exact issuer role, owner, service, generation, and loopback origin", () => {
    // Given / When / Then
    expect(parseNativeGitWorkspaceWriteIssuerConnection(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, role: "operator-root-read-issuer" },
      { ...valid, hostId: "Host A" },
      { ...valid, serviceId: "native-other" },
      { ...valid, generationId: "b".repeat(63) },
      { ...valid, endpoint: "http://192.0.2.1:8080" },
      { ...valid, endpoint: "http://127.0.0.1:8080/v1" },
      { ...valid, credential: { ...valid.credential, password: "wrong" } },
      { ...valid, added: "unexpected" }
    ]) {
      expect(() => parseNativeGitWorkspaceWriteIssuerConnection(invalid))
        .toThrow(NativeGitWorkspaceWriteIssuerConnectionError);
    }
  });

  it("reads only a mode-0600 owner-only single-link regular file", async () => {
    // Given
    const root = await temporaryRoot("connection");
    const path = join(root, "issuer.json");
    await writeFile(path, JSON.stringify(valid), { mode: 0o600 });

    // When / Then
    expect(await loadNativeGitWorkspaceWriteIssuerConnection(path)).toEqual(valid);
    const alias = join(root, "alias.json");
    await symlink(path, alias);
    await expect(loadNativeGitWorkspaceWriteIssuerConnection(alias))
      .rejects.toThrow(NativeGitWorkspaceWriteIssuerConnectionError);
    const hardlink = join(root, "hardlink.json");
    await link(path, hardlink);
    await expect(loadNativeGitWorkspaceWriteIssuerConnection(path))
      .rejects.toThrow(NativeGitWorkspaceWriteIssuerConnectionError);
  });

  it("refuses permissive, empty, and oversized issuer files", async () => {
    // Given
    const root = await temporaryRoot("invalid-files");
    const permissive = join(root, "permissive.json");
    const empty = join(root, "empty.json");
    const oversized = join(root, "oversized.json");
    await writeFile(permissive, JSON.stringify(valid), { mode: 0o640 });
    await chmod(permissive, 0o640);
    await writeFile(empty, "", { mode: 0o600 });
    await writeFile(oversized, "x".repeat(16 * 1024 + 1), { mode: 0o600 });

    // When / Then
    for (const path of [permissive, empty, oversized]) {
      await expect(loadNativeGitWorkspaceWriteIssuerConnection(path))
        .rejects.toThrow(NativeGitWorkspaceWriteIssuerConnectionError);
    }
  });
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dim-workspace-write-issuer-${label}-`));
  roots.push(root);
  return root;
}
