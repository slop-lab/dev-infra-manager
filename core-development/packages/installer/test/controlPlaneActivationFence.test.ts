import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installControlPlane,
  installFirstControlPlane
} from "../../../../core/packages/installer/src/controlPlaneInstall.js";
import { FirstInstallRunner } from "./controlPlaneInstallFixture.js";
import {
  deterministicRandom,
  exists,
  installFixture,
  writeChangedImages
} from "./controlPlaneInstallTestSupport.js";

describe("control-plane candidate activation fence", () => {
  it("restores exact prior services and root bytes when replacement fails before activation", async () => {
    // Given: a healthy prior generation and a failure replacing the second candidate service.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const prior = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });
    const priorInstall = await readFile(join(input.stateRoot, "install.json"));
    const priorCompose = await readFile(join(input.stateRoot, "compose.yml"));
    await writeChangedImages(input.configPath);
    runner.calls.splice(0);
    runner.failReplacementNumber = 2;

    // When: replacement fails before candidate activation starts.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });

    // Then: automatic rollback restores generation A exactly.
    await expect(action).rejects.toThrow(/exact prior generation was restored/);
    expect((await readFile(join(input.stateRoot, "install.json"))).equals(priorInstall)).toBe(true);
    expect((await readFile(join(input.stateRoot, "compose.yml"))).equals(priorCompose)).toBe(true);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(false);
    expect(runner.nativeRuntime?.image).toBe(prior.record.nativeGitImage);
    expect(runner.ordinaryRuntime?.image).toBe(prior.record.ordinaryCiImage);
    expect(runner.calls.filter(({ args }) => args.includes("--force-recreate"))).toHaveLength(4);
  });

  it.each(["ordinary-ci", "native-git"] as const)(
    "retains the published candidate and prior generation when %s activation fails",
    async (service) => {
      // Given: generation A is installed and generation B is ready to activate.
      const input = await installFixture();
      const runner = new FirstInstallRunner();
      const prior = await installControlPlane({
        configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
      });
      const priorInstall = await readFile(join(input.stateRoot, "install.json"));
      await writeChangedImages(input.configPath);
      runner.calls.splice(0);
      runner.failActivationService = service;

      // When: activation fails after candidate publication.
      const action = installControlPlane({
        configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
      });

      // Then: activation is explicitly uncertain and no automatic restoration of A begins.
      await expect(action).rejects.toThrow(/activation outcome is uncertain/);
      expect((await readFile(join(input.stateRoot, "install.json"))).equals(priorInstall)).toBe(false);
      expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(true);
      expect(await readdir(join(input.stateRoot, "generations"))).toHaveLength(2);
      expect(runner.nativeRuntime?.generationId).not.toBe(prior.record.generationId);
      expect(runner.ordinaryRuntime?.generationId).not.toBe(prior.record.generationId);
      expect(runner.nativeVolume && runner.ordinaryVolume).toBe(true);
      expect(runner.calls.filter(({ args }) => args.includes("--force-recreate"))).toHaveLength(2);
      expect(runner.calls.some(({ args }) => args[1] === "rm")).toBe(false);
    }
  );

  it("retains the activated update when installed-state completion fails", async () => {
    // Given: generation A is installed and completion will fail after both B activations.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const prior = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });
    const priorInstall = await readFile(join(input.stateRoot, "install.json"));
    await writeChangedImages(input.configPath);
    runner.calls.splice(0);
    runner.failCompletionAfterActivation = true;

    // When: journal completion fails after activation succeeds.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });

    // Then: B and recovery evidence remain without any attempted replacement of A.
    await expect(action).rejects.toThrow(/activation outcome is uncertain/);
    expect((await readFile(join(input.stateRoot, "install.json"))).equals(priorInstall)).toBe(false);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(true);
    expect(await readdir(join(input.stateRoot, "generations"))).toHaveLength(2);
    expect(runner.nativeRuntime?.generationId).not.toBe(prior.record.generationId);
    expect(runner.ordinaryRuntime?.generationId).not.toBe(prior.record.generationId);
    expect(runner.nativeVolume && runner.ordinaryVolume).toBe(true);
    expect(runner.calls.filter(({ args }) => args.includes("--force-recreate"))).toHaveLength(2);
    expect(runner.calls.some(({ args }) => args[1] === "rm")).toBe(false);
  });

  it("retains first-install resources when candidate activation fails", async () => {
    // Given: an absent deployment whose ordinary candidate activation will fail.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    runner.failActivationService = "ordinary-ci";

    // When: first-install activation fails after installed-state publication.
    const action = installFirstControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });

    // Then: uncertain activation leaves every exact-owned resource and recovery artifact in place.
    await expect(action).rejects.toThrow(/activation outcome is uncertain/);
    expect(await exists(join(input.stateRoot, "install.json"))).toBe(true);
    expect(await exists(join(input.stateRoot, "compose.yml"))).toBe(true);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(true);
    expect(await readdir(join(input.stateRoot, "generations"))).toHaveLength(1);
    expect(runner.network && runner.nativeContainer && runner.ordinaryContainer).toBe(true);
    expect(runner.nativeVolume && runner.ordinaryVolume).toBe(true);
    expect(runner.calls.some(({ args }) => args[1] === "rm")).toBe(false);
  });
});
