import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseNativeGitBundleConfig } from "../../../../core/packages/native-git/src/bundle-config.js";
import { configuredNativeGitBundleServer } from "../../../../core/packages/native-git/src/native-bundle-server.js";
import { idleNativeConfig } from "./bundleConfigFixture.js";
import { isExitError } from "./nativeGitHarness.js";

const run = promisify(execFile);
const generationId = "a".repeat(64);
const readinessToken = Buffer.alloc(32, 41).toString("base64url");
const activationToken = Buffer.alloc(32, 42).toString("base64url");
const rejectedWriterPassword = Buffer.alloc(32, 51).toString("base64url");
const registrar = {
  hostId: "host-a", username: "project-registrar-a", password: Buffer.alloc(32, 43).toString("base64url")
} as const;
const preparation = {
  serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root"
} as const;

describe("native Git prepared credential boundaries", () => {
  it.each([
    ["readiness", readinessToken],
    ["activation", activationToken]
  ])("rejects a root importer reusing the %s token before acquiring state", async (_label, password) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "dim-native-importer-collision-"));
    try {
      const config = parseNativeGitBundleConfig({
        ...idleNativeConfig(),
        projectRegistrars: [registrar],
        projectRootImporters: [{ hostId: "host-a", username: "root-importer-a", password }]
      });

      await expect(configuredNativeGitBundleServer({
        config, stateDirectory, readinessToken, activationToken, expectedGenerationId: generationId
      })).rejects.toThrow(/credentials must be distinct/);
      expect(await readdir(stateDirectory)).toEqual([]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ["readiness", readinessToken],
    ["activation", activationToken]
  ])("rejects a root read issuer reusing the %s token before acquiring state", async (_label, password) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "dim-native-read-issuer-collision-"));
    try {
      const config = parseNativeGitBundleConfig({
        ...idleNativeConfig(),
        projectRegistrars: [registrar],
        projectRootReadIssuers: [{ hostId: "host-a", username: "root-read-issuer-a", password }]
      });

      await expect(configuredNativeGitBundleServer({
        config, stateDirectory, readinessToken, activationToken, expectedGenerationId: generationId
      })).rejects.toThrow(/credentials must be distinct/);
      expect(await readdir(stateDirectory)).toEqual([]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ["readiness", readinessToken],
    ["activation", activationToken]
  ])("rejects a workspace write issuer reusing the %s token before acquiring state", async (_label, password) => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "dim-native-write-issuer-collision-"));
    try {
      const config = parseNativeGitBundleConfig({
        ...idleNativeConfig(),
        projectRegistrars: [registrar],
        workspaceWriteIssuers: [{ hostId: "host-a", username: "workspace-write-issuer-a", password }]
      });

      await expect(configuredNativeGitBundleServer({
        config, stateDirectory, readinessToken, activationToken, expectedGenerationId: generationId
      })).rejects.toThrow(/credentials must be distinct/);
      expect(await readdir(stateDirectory)).toEqual([]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("does not grant Git transport to a configured root read issuer", async () => {
    // Given
    const stateDirectory = await mkdtemp(join(tmpdir(), "dim-native-read-issuer-transport-"));
    const issuer = {
      hostId: "host-a", username: "root-read-issuer-a", password: Buffer.alloc(32, 44).toString("base64url")
    } as const;
    try {
      const service = await configuredNativeGitBundleServer({
        config: parseNativeGitBundleConfig({
          ...idleNativeConfig(), projectRegistrars: [registrar], projectRootReadIssuers: [issuer]
        }),
        stateDirectory, readinessToken, activationToken, expectedGenerationId: generationId
      });
      const origin = await service.listen("127.0.0.1", 0);
      const activation = await fetch(`${origin}/v1/activation`, {
        method: "POST",
        headers: { authorization: `Bearer ${activationToken}`, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, generationId })
      });
      expect(activation.status).toBe(200);
      const authenticated = origin.replace("http://", `http://${issuer.username}:${issuer.password}@`);

      // When
      const transport = run("/usr/bin/git", ["ls-remote",
        `${authenticated}/v1/projects/project-a/repositories/root.git`], {
        cwd: stateDirectory, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
      });

      // Then
      await expect(transport)
        .rejects.toSatisfy((error: unknown) => isExitError(error)
          && /(?:Authentication failed|requested URL returned error: 403)/.test(error.stderr));
      await service.close();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("does not retain or revive a caller-supplied writer credential across restart", async () => {
    // Given
    const stateDirectory = await mkdtemp(join(tmpdir(), "dim-native-credential-"));
    const options = {
      config: parseNativeGitBundleConfig({ ...idleNativeConfig(), projectRegistrars: [registrar] }), stateDirectory,
      readinessToken, activationToken, expectedGenerationId: generationId
    } as const;
    try {
      const first = await configuredNativeGitBundleServer(options);
      const origin = await first.listen("127.0.0.1", 0);
      const activation = await fetch(`${origin}/v1/activation`, {
        method: "POST",
        headers: { authorization: `Bearer ${activationToken}`, "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, generationId })
      });
      expect(activation.status).toBe(200);
      await first.prepareProject(generationId, registrar.hostId, preparation);
      await first.close();
      const databasePath = join(stateDirectory, "native-idle.sqlite3");
      const before = await readFile(databasePath);
      const changedConfig = parseNativeGitBundleConfig({
        ...idleNativeConfig(),
        projectRegistrars: [registrar],
        ordinaryCi: {
          ...idleNativeConfig().ordinaryCi,
          query: { ...idleNativeConfig().ordinaryCi.query, password: rejectedWriterPassword }
        }
      });

      // When
      const restarted = await configuredNativeGitBundleServer({ ...options, config: changedConfig });
      const restartedOrigin = await restarted.listen("127.0.0.1", 0);
      const authenticated = restartedOrigin.replace(
        "http://",
        `http://writer-a:${rejectedWriterPassword}@`
      );
      const transport = run("/usr/bin/git", ["ls-remote",
        `${authenticated}/v1/projects/project-a/repositories/root.git`], {
        cwd: stateDirectory, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
      });

      // Then
      await expect(transport)
        .rejects.toSatisfy((error: unknown) => isExitError(error) && /Authentication failed/.test(error.stderr));
      expect(await readFile(databasePath)).toEqual(before);
      expect(before.includes(Buffer.from(rejectedWriterPassword))).toBe(false);
      await restarted.close();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
