import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseControlPlaneConfig } from "../../../../core/packages/installer/src/controlPlaneConfig.js";
import {
  completeControlPlaneSourcePreflight,
  readControlPlaneSources
} from "../../../../core/packages/installer/src/controlPlaneSources.js";
import {
  controlPlaneSecrets,
  ordinaryServiceConfig,
  writeControlPlaneFixture,
  writePrivate
} from "./controlPlaneFixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dim-control-plane-sources-"));
  temporaryDirectories.push(directory);
  const value = await writeControlPlaneFixture(directory);
  return { ...value, parsed: parseControlPlaneConfig(value.config, ["127.0.0.1"]) };
}

describe("control-plane private source staging", () => {
  it("reads four stable private sources and records their exact digests", async () => {
    const input = await fixture();
    const sources = await readControlPlaneSources(input.parsed);

    expect(sources.nativeGit.config.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sources.nativeGit.readinessToken.value).toBe(controlPlaneSecrets.nativeReadiness);
    expect(sources.ordinaryCi.readinessToken.value).toBe(controlPlaneSecrets.ordinaryReadiness);
    expect(sources.serviceConfigPreflight.kind).toBe("requires-image-validation");

    const complete = completeControlPlaneSourcePreflight(sources, {
      nativeGit: Buffer.from(`${controlPlaneSecrets.nativeActivation}\n`),
      ordinaryCi: Buffer.from(`${controlPlaneSecrets.ordinaryActivation}\n`)
    });
    expect(complete.allSecretValues).toHaveLength(11);
  });

  it("rejects noncanonical, short, reused, and symlinked token sources", async () => {
    const input = await fixture();
    await writePrivate(input.paths.nativeReadiness, `${Buffer.alloc(31, 8).toString("base64url")}\n`);
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/token/);

    await writePrivate(input.paths.nativeReadiness, `${controlPlaneSecrets.query}\n`);
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/distinct/);

    const target = join(join(input.configPath, ".."), "target.token");
    await writePrivate(target, `${controlPlaneSecrets.nativeReadiness}\n`);
    await rm(input.paths.nativeReadiness);
    await symlink(target, input.paths.nativeReadiness);
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow();
  });

  it("rejects malformed service JSON, oversized files, and colliding activation tokens", async () => {
    const input = await fixture();
    await writePrivate(input.paths.nativeConfig, "{\n");
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/JSON/);

    await writePrivate(input.paths.nativeConfig, "x".repeat(1_048_577));
    await expect(readControlPlaneSources(input.parsed)).rejects.toThrow(/large/);

    const restored = await fixture();
    const sources = await readControlPlaneSources(restored.parsed);
    expect(() => completeControlPlaneSourcePreflight(sources, {
      nativeGit: Buffer.from(`${controlPlaneSecrets.nativeReadiness}\n`),
      ordinaryCi: Buffer.from(`${controlPlaneSecrets.ordinaryActivation}\n`)
    })).toThrow(/distinct/);
  });

  it("rejects a credential reused for a different service role", async () => {
    // Given
    const input = await fixture();
    await writePrivate(input.paths.ordinaryConfig, `${JSON.stringify(ordinaryServiceConfig(controlPlaneSecrets.host))}\n`);

    // When
    const action = readControlPlaneSources(input.parsed);

    // Then
    await expect(action).rejects.toThrow(/distinct/);
  });
});
