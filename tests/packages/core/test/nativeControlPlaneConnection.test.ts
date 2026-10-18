import { execFile } from "node:child_process";
import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNativeControlPlaneConnection,
  NativeControlPlaneConnectionError,
  parseNativeControlPlaneConnection
} from "../../../../core/packages/managed/src/nativeControlPlaneConnection.js";

const token = (byte: number): string => Buffer.alloc(32, byte).toString("base64url");
const valid = {
  schemaVersion: 1,
  hostId: "host-a",
  nativeGit: {
    transport: "loopback-http", endpoint: "http://127.0.0.1:9080", serviceId: "native-main",
    generationId: "a".repeat(64),
    workspaceWriteIssuer: { username: "workspace-writer-a", password: token(1) },
    rootReadIssuer: { username: "root-read-a", password: token(3) }
  }
} as const;
const roots: string[] = [];
const run = promisify(execFile);

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
  it("parses an exact host manifest and selects native lifecycle authority", async () => {
    // Given
    const path = await connectionFile();

    // When
    const connection = await loadNativeControlPlaneConnection(path);

    // Then
    expect(connection).toEqual(valid);
    expect(parseNativeControlPlaneConnection(valid)).toEqual(valid);
  });

  it("rejects foreign authorities and candidate-selected resources", () => {
    // Given
    const invalid = [
      { ...valid, projects: { acme: {} } },
      { ...valid, ordinaryCi: {} },
      { ...valid, capacities: {} },
      { ...valid, schemaVersion: 2 },
      { ...valid, nativeGit: { ...valid.nativeGit, serviceId: "foreign" } },
      { ...valid, nativeGit: { ...valid.nativeGit, generationId: "b" } },
      { ...valid, nativeGit: { ...valid.nativeGit,
        rootReadIssuer: { ...valid.nativeGit.rootReadIssuer,
          password: valid.nativeGit.workspaceWriteIssuer.password } } },
      { ...valid, nativeGit: { ...valid.nativeGit, endpoint: "http://127.0.0.1:9080/v1" } },
      { ...valid, nativeGit: { ...valid.nativeGit, endpoint: "http://user:pass@127.0.0.1:9080" } },
    ];

    // When / Then
    for (const input of invalid) {
      expect(() => parseNativeControlPlaneConnection(input)).toThrow(NativeControlPlaneConnectionError);
    }
  });

  it("accepts verified HTTPS and bracketed IPv6 loopback origins", () => {
    // Given / When / Then
    expect(parseNativeControlPlaneConnection({ ...valid, nativeGit: {
      ...valid.nativeGit, transport: "https", endpoint: "https://native.example"
    } })).toMatchObject({ nativeGit: { endpoint: "https://native.example" } });
    expect(parseNativeControlPlaneConnection({ ...valid, nativeGit: {
      ...valid.nativeGit, endpoint: "http://[::1]:9080"
    } })).toMatchObject({ nativeGit: { endpoint: "http://[::1]:9080" } });
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

  it("rejects repeated credential names before JSON parsing discards the first value", async () => {
    // Given
    const duplicate = JSON.stringify(valid).replace('"username":', '"username":"foreign","username":');
    const path = await connectionFile(duplicate);
    const escaped = await connectionFile(JSON.stringify(valid).replace('"username":', '"username":"foreign","userna\\u006de":'));

    // When / Then
    await expect(loadNativeControlPlaneConnection(path)).rejects.toThrow(NativeControlPlaneConnectionError);
    await expect(loadNativeControlPlaneConnection(escaped)).rejects.toThrow(NativeControlPlaneConnectionError);
  });

  it("rejects an owner-mode FIFO without blocking", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-native-control-fifo-"));
    roots.push(root);
    const path = join(root, "connection.json");
    await run("/usr/bin/mkfifo", [path]);
    await chmod(path, 0o600);
    const moduleUrl = pathToFileURL(join(import.meta.dirname,
      "../../../../core/packages/managed/dist/nativeControlPlaneConnection.js")).href;

    // When
    const child = run(process.execPath, ["--input-type=module", "-e", `
      const { loadNativeControlPlaneConnection } = await import(process.env.DIM_TEST_MODULE);
      await loadNativeControlPlaneConnection(process.env.DIM_TEST_PATH).then(
        () => process.exit(1),
        () => process.exit(0),
      );
    `], { env: { ...process.env, DIM_TEST_MODULE: moduleUrl, DIM_TEST_PATH: path }, timeout: 1_000 });

    // Then
    await expect(child).resolves.toMatchObject({ stdout: "", stderr: "" });
  });
});
