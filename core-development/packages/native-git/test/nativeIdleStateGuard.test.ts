import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNativeGitBundleConfig } from "../../../../core/packages/native-git/src/bundle-config.js";
import { activationTokenSha256, bindExactActivation } from "../../../../core/packages/native-git/src/native-bundle-activation.js";
import { initializeNativeGitBundleState, registerNativeProject } from "../../../../core/packages/native-git/src/native-bundle-state.js";
import { configuredNativeGitIdleServer } from "../../../../core/packages/native-git/src/native-idle-service.js";
import { idleNativeConfig } from "./bundleConfigFixture.js";

const generationId = "a".repeat(64);
const readinessToken = Buffer.alloc(32, 41).toString("base64url");
const activationToken = Buffer.alloc(32, 42).toString("base64url");

describe("native Git idle service authority", () => {
  it("refuses a registered Project when registrar authority is absent without retaining storage ownership", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "dim-native-idle-guard-"));
    try {
      const state = await initializeNativeGitBundleState(stateDirectory);
      bindExactActivation(state, generationId, activationTokenSha256(activationToken));
      registerNativeProject(state, generationId, {
        serviceId: "native-main", projectId: "project-a", rootRepositoryId: "root", ownerHostId: "host-a"
      });
      await state.owner.release();

      await expect(configuredNativeGitIdleServer({
        config: parseNativeGitBundleConfig(idleNativeConfig()), stateDirectory,
        readinessToken, activationToken, expectedGenerationId: generationId
      })).rejects.toThrow(/registered Project/);
      const recovered = await initializeNativeGitBundleState(stateDirectory);
      await recovered.owner.release();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("refuses configured registrar authority on the idle server", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "dim-native-idle-guard-"));
    try {
      const registration = {
        hostId: "host-a", username: "registrar-a", password: Buffer.alloc(32, 43).toString("base64url")
      } as const;
      await expect(configuredNativeGitIdleServer({
        config: parseNativeGitBundleConfig({ ...idleNativeConfig(), projectRegistrars: [registration] }),
        stateDirectory, readinessToken, activationToken, expectedGenerationId: generationId
      })).rejects.toThrow(/registrar/);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("refuses configured importer authority on the idle server before creating state", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "dim-native-idle-guard-"));
    try {
      const importer = {
        hostId: "host-a", username: "root-importer-a", password: Buffer.alloc(32, 43).toString("base64url")
      } as const;
      await expect(configuredNativeGitIdleServer({
        config: parseNativeGitBundleConfig({ ...idleNativeConfig(), projectRootImporters: [importer] }),
        stateDirectory, readinessToken, activationToken, expectedGenerationId: generationId
      })).rejects.toThrow(/importer/);
      expect(await readdir(stateDirectory)).toEqual([]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("refuses configured root read issuer authority on the idle server before creating state", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "dim-native-idle-guard-"));
    try {
      const issuer = {
        hostId: "host-a", username: "root-read-issuer-a", password: Buffer.alloc(32, 44).toString("base64url")
      } as const;
      await expect(configuredNativeGitIdleServer({
        config: parseNativeGitBundleConfig({ ...idleNativeConfig(), projectRootReadIssuers: [issuer] }),
        stateDirectory, readinessToken, activationToken, expectedGenerationId: generationId
      })).rejects.toThrow(/read issuer/);
      expect(await readdir(stateDirectory)).toEqual([]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
