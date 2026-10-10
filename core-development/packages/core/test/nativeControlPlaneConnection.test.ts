import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import {
  loadNativeControlPlaneConnection,
  NativeControlPlaneConnectionError,
  parseNativeControlPlaneConnection
} from "../../../../core/packages/core/src/nativeControlPlaneConnection.js";

const token = (byte: number): string => Buffer.alloc(32, byte).toString("base64url");
const capacity = {
  runnerBaseImage: `registry.example/ordinary-runner@sha256:${"c".repeat(64)}`,
  jobBaseImage: `registry.example/ordinary-job@sha256:${"d".repeat(64)}`,
  cpus: 4, memoryBytes: 8589934592, pids: 2048, timeoutSeconds: 3600, outputBytes: 16777216
} as const;
const valid = {
  schemaVersion: 1,
  hostId: "host-a",
  nativeGit: {
    transport: "loopback-http", endpoint: "http://127.0.0.1:9080", serviceId: "native-main",
    username: "host-a", password: token(1)
  },
  ordinaryCi: {
    transport: "loopback-http", endpoint: "http://127.0.0.1:9081", serviceId: "ordinary-main",
    hostToken: token(2)
  },
  capacities: { primary: capacity }
} as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function connectionFile(contents: string = JSON.stringify(valid)): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-control-plane-"));
  roots.push(root);
  const path = join(root, "connection.json");
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

describe("native control-plane host connection", () => {
  it("parses an exact host manifest without enabling lifecycle authority", async () => {
    // Given
    const path = await connectionFile();

    // When
    const connection = await loadNativeControlPlaneConnection(path);

    // Then
    expect(connection).toEqual(valid);
    expect(parseNativeControlPlaneConnection(valid)).toEqual(valid);
    expect(() => lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/dim", DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: path,
      DIM_GITEA_CONNECTION_FILE: "/not-used"
    })).toThrow(/refusing Gitea fallback/);
  });

  it("rejects foreign authorities and candidate-selected resources", () => {
    // Given
    const invalid = [
      { ...valid, projects: { acme: {} } },
      { ...valid, schemaVersion: 2 },
      { ...valid, nativeGit: { ...valid.nativeGit, serviceId: "foreign" } },
      { ...valid, nativeGit: { ...valid.nativeGit, username: "host-b" } },
      { ...valid, nativeGit: { ...valid.nativeGit, password: valid.ordinaryCi.hostToken } },
      { ...valid, ordinaryCi: { ...valid.ordinaryCi, endpoint: "http://remote.example" } },
      { ...valid, nativeGit: { ...valid.nativeGit, endpoint: "http://127.0.0.1:9080/v1" } },
      { ...valid, nativeGit: { ...valid.nativeGit, endpoint: "http://user:pass@127.0.0.1:9080" } },
      { ...valid, ordinaryCi: { ...valid.ordinaryCi, transport: "https" } },
      { ...valid, capacities: {} },
      { ...valid, capacities: { Primary: capacity } },
      { ...valid, capacities: { primary: { ...capacity, jobBaseImage: "ordinary-job:latest" } } },
      { ...valid, capacities: { primary: { ...capacity, cpus: 0 } } },
      { ...valid, capacities: { primary: { ...capacity, labels: ["native"] } } }
    ];

    // When / Then
    for (const input of invalid) {
      expect(() => parseNativeControlPlaneConnection(input)).toThrow(NativeControlPlaneConnectionError);
    }
  });

  it("rejects linked, permissive, oversized, and malformed host files", async () => {
    // Given
    const path = await connectionFile();
    const linkRoot = await mkdtemp(join(tmpdir(), "dim-native-control-links-"));
    roots.push(linkRoot);
    const alias = join(linkRoot, "alias.json");
    await symlink(path, alias);

    // When / Then
    await expect(loadNativeControlPlaneConnection(alias)).rejects.toThrow(NativeControlPlaneConnectionError);
    await link(path, join(linkRoot, "hardlink.json"));
    await expect(loadNativeControlPlaneConnection(path)).rejects.toThrow(NativeControlPlaneConnectionError);
    await expect(loadNativeControlPlaneConnection(await connectionFile("{"))).rejects.toThrow(NativeControlPlaneConnectionError);
    await expect(loadNativeControlPlaneConnection(await connectionFile("x".repeat(64 * 1024 + 1))))
      .rejects.toThrow(NativeControlPlaneConnectionError);
    const permissive = await connectionFile();
    await chmod(permissive, 0o640);
    await expect(loadNativeControlPlaneConnection(permissive)).rejects.toThrow(NativeControlPlaneConnectionError);
  });

  it("rejects repeated capacity names before JSON parsing discards the first value", async () => {
    // Given
    const duplicate = JSON.stringify(valid).replace('"primary":{', '"primary":{},"primary":{');
    const path = await connectionFile(duplicate);
    const escaped = await connectionFile(JSON.stringify(valid).replace('"primary":{', '"primary":{},"pr\\u0069mary":{'));

    // When / Then
    await expect(loadNativeControlPlaneConnection(path)).rejects.toThrow(NativeControlPlaneConnectionError);
    await expect(loadNativeControlPlaneConnection(escaped)).rejects.toThrow(NativeControlPlaneConnectionError);
  });
});
