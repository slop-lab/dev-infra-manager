import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNativeGitProjectRegistrarConnection,
  NativeGitProjectRegistrarConnectionError
} from "../../../../core/packages/core/src/nativeGitProjectRegistrarConnection.js";

const roots: string[] = [];
const password = Buffer.alloc(32, 71).toString("base64url");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native Git Project registrar connection", () => {
  it("loads an exact private schema-1 loopback connection", async () => {
    // Given
    const path = await connectionFile(connection());

    // When
    const loaded = await loadNativeGitProjectRegistrarConnection(path);

    // Then
    expect(loaded).toEqual(connection());
  });

  it.each([
    ["non-loopback origin", { endpoint: "http://192.0.2.10:9080" }],
    ["HTTPS origin", { endpoint: "https://127.0.0.1:9080" }],
    ["credential in origin", { endpoint: "http://registrar:secret@127.0.0.1:9080" }],
    ["origin path", { endpoint: "http://127.0.0.1:9080/api" }],
    ["wrong schema", { schemaVersion: 2 }],
    ["extra field", { hostToken: password }]
  ])("rejects a %s", async (_label, change) => {
    const path = await connectionFile({ ...connection(), ...change });
    await expect(loadNativeGitProjectRegistrarConnection(path))
      .rejects.toBeInstanceOf(NativeGitProjectRegistrarConnectionError);
  });

  it("rejects permissive, linked, symbolic, empty, and oversized files", async () => {
    // Given
    const root = await temporaryRoot();
    const permissive = join(root, "permissive.json");
    const linked = join(root, "linked.json");
    const linkedAlias = join(root, "linked-alias.json");
    const symbolic = join(root, "symbolic.json");
    const empty = join(root, "empty.json");
    const oversized = join(root, "oversized.json");
    await writeFile(permissive, JSON.stringify(connection()), { mode: 0o640 });
    await chmod(permissive, 0o640);
    await writeFile(linked, JSON.stringify(connection()), { mode: 0o600 });
    await link(linked, linkedAlias);
    await symlink(linked, symbolic);
    await writeFile(empty, "", { mode: 0o600 });
    await writeFile(oversized, "x".repeat(16 * 1024 + 1), { mode: 0o600 });

    // When / Then
    for (const path of [permissive, linked, symbolic, empty, oversized]) {
      await expect(loadNativeGitProjectRegistrarConnection(path))
        .rejects.toBeInstanceOf(NativeGitProjectRegistrarConnectionError);
    }
  });
});

function connection() {
  return {
    schemaVersion: 1,
    endpoint: "http://127.0.0.1:9080",
    serviceId: "native-main",
    hostId: "host-a",
    generationId: "a".repeat(64),
    credential: { username: "project-registrar-a", password }
  } as const;
}

async function connectionFile(value: unknown): Promise<string> {
  const root = await temporaryRoot();
  const path = join(root, "registrar.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-registrar-connection-"));
  roots.push(root);
  return root;
}
