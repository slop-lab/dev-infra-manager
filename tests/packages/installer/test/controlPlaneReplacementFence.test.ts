import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installControlPlane } from "../../../../core/packages/installer/src/controlPlaneInstall.js";
import { FirstInstallRunner } from "./controlPlaneInstallFixture.js";
import {
  deterministicRandom,
  exists,
  installFixture,
  immediateReadinessDeadline,
  ObservingReadiness,
  writeChangedImages
} from "./controlPlaneInstallTestSupport.js";

describe("control-plane replacement resource fence", () => {
  it("rejects a wrong candidate image ID before candidate readiness and restores the prior generation", async () => {
    // Given: a healthy installation and a candidate whose first replacement keeps the wrong immutable image ID.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const readiness = new ObservingReadiness(input.stateRoot, runner);
    await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });
    await writeChangedImages(input.configPath);
    runner.runtimeFaultAt = { start: 3, kind: "image" };
    runner.calls.splice(0);
    readiness.events.splice(0);
    readiness.expectInstalled = true;

    // When: the candidate ordinary service is replaced.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });

    // Then: readiness occurs only after rollback has replaced the bad candidate again.
    await expect(action).rejects.toThrow(/exact prior generation was restored/);
    const replacements = runner.calls.filter(({ args }) => args.includes("--force-recreate"));
    expect(replacements.map(({ args }) => args.at(-1))).toEqual(["ordinary-ci", "ordinary-ci", "native-git"]);
    expect(readiness.events).toEqual(["ready:ordinary", "ready:native"]);
  });

  it("fails rollback before readiness when the replacement target has wrong mounts", async () => {
    // Given: native candidate readiness triggers rollback and rollback ordinary has a foreign bind.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner,
      randomBytes: deterministicRandom()
    });
    await writeChangedImages(input.configPath);
    runner.runtimeFaultAt = { start: 5, kind: "mount" };
    runner.readinessEvents.splice(0);
    const readiness = new ObservingReadiness(input.stateRoot, runner, false, "ready:native", true);

    // When: rollback recreates ordinary from the retained prior Compose bytes.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom(),
      readinessPolicy: immediateReadinessDeadline
    });

    // Then: rollback refuses readiness/publication and retains recovery evidence.
    await expect(action).rejects.toThrow(/update and rollback failed/);
    expect(readiness.events).toEqual(["ready:ordinary", "ready:native"]);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(true);
  });
});
