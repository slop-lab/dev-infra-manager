import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { installControlPlane } from "../../../../core/packages/installer/src/controlPlaneInstall.js";
import {
  ControlPlaneInstallError,
  controlPlaneFailureCode,
  formatControlPlaneInstallError
} from "../../../../core/packages/installer/src/controlPlaneInstallError.js";
import {
  ControlPlaneStateFilesystemError,
  replaceStateFile
} from "../../../../core/packages/installer/src/controlPlaneStateFs.js";
import { FirstInstallRunner } from "./controlPlaneInstallFixture.js";
import {
  deterministicRandom,
  exists,
  immediateReadinessDeadline,
  installFixture,
  ObservingReadiness,
  writeChangedImages
} from "./controlPlaneInstallTestSupport.js";

describe("control-plane rollback diagnostics", () => {
  it("classifies a failed installed-state replacement as a state operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-control-plane-publish-error-"));
    try {
      const target = join(root, "install.json");
      await mkdir(target);
      const error = await replaceStateFile(target, Buffer.from("candidate")).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ControlPlaneStateFilesystemError);
      expect(controlPlaneFailureCode(error)).toBe("state-operation-failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports distinct safe causes and retained evidence when update rollback fails", async () => {
    // Given: an installed generation, a candidate readiness failure, and rollback replacement failure.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const prior = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });
    await writeChangedImages(input.configPath);
    runner.failReplacementNumber = 3;
    new ObservingReadiness(input.stateRoot, runner, false, "ready:native", true);

    // When: rollback cannot restore the first prior service.
    const error = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom(),
      readinessPolicy: immediateReadinessDeadline
    }).catch((failure: unknown) => failure);

    // Then: typed details drive diagnostics while the original aggregate remains available.
    if (!(error instanceof ControlPlaneInstallError) || error.details?.kind !== "rollback") {
      throw new TypeError("expected typed control-plane rollback details");
    }
    expect(error.details).toMatchObject({
      originalCode: "readiness-failed",
      rollbackCode: "service-replacement-failed",
      priorGeneration: prior.record.generationId,
      volumes: ["dim-control-plane-native-git-data", "dim-control-plane-ordinary-ci-data"]
    });
    expect(error.cause).toBeInstanceOf(AggregateError);
    if (!(error.cause instanceof AggregateError)) throw new TypeError("expected aggregate update and rollback cause");
    expect(error.cause.errors).toHaveLength(2);
    const diagnostics = formatControlPlaneInstallError(error).join("\n");
    expect(diagnostics).toContain("original failure: service readiness failure");
    expect(diagnostics).toContain("rollback failure: service replacement failure");
    expect(diagnostics).toContain(`retained prior generation: ${prior.record.generationId}`);
    expect(diagnostics).toContain(`retained candidate generation: ${error.details.candidateGeneration}`);
    expect(diagnostics).toContain("retained data volume: dim-control-plane-native-git-data");
    expect(diagnostics).toContain("retained data volume: dim-control-plane-ordinary-ci-data");
    expect(diagnostics).not.toContain("readiness refused");
    expect(diagnostics).not.toContain("replacement failed");
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(true);
    expect(await readdir(join(input.stateRoot, "generations"))).toEqual(
      expect.arrayContaining([prior.record.generationId, error.details.candidateGeneration])
    );
    expect(runner.nativeVolume && runner.ordinaryVolume).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === "volume" && args[1] === "rm")).toBe(false);
  });
});
