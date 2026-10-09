import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installControlPlane } from "../../../../core/packages/installer/src/controlPlaneInstall.js";
import { FirstInstallRunner, isolationRuntimeFaults } from "./controlPlaneInstallFixture.js";
import {
  deterministicRandom,
  exists,
  installFixture,
  immediateReadinessDeadline,
  ObservingReadiness,
  writeChangedImages,
  writeChangedPorts
} from "./controlPlaneInstallTestSupport.js";

describe("unified control-plane installation", () => {
  it("returns an exact healthy installation as a no-op without allocating or mutating resources", async () => {
    // Given: one completed installation and the same immutable operator inputs.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const readiness = new ObservingReadiness(input.stateRoot, runner);
    await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });
    const installBytes = await readFile(join(input.stateRoot, "install.json"));
    const composeBytes = await readFile(join(input.stateRoot, "compose.yml"));
    runner.calls.splice(0);
    readiness.events.splice(0);
    readiness.expectInstalled = true;
    let allocations = 0;

    // When: the unified installer is invoked again with byte-identical inputs.
    const installed = await installControlPlane({
      configPath: input.configPath,
      stateRoot: input.stateRoot,
      runner,
      randomBytes: (size) => {
        allocations += 1;
        return Buffer.alloc(size, 99);
      }
    });

    // Then: health is verified without image probes or resource changes.
    expect(installed.record.generationId).toMatch(/^[0-9a-f]{64}$/);
    expect(allocations).toBe(0);
    expect(runner.calls.some(({ args }) => args.includes("up") || args[1] === "create" || args[1] === "rm")).toBe(false);
    expect(runner.calls.some(({ args }) => args[0] === "pull" || args[0] === "run")).toBe(false);
    expect(await readdir(join(input.stateRoot, "generations"))).toHaveLength(1);
    expect((await readFile(join(input.stateRoot, "install.json"))).equals(installBytes)).toBe(true);
    expect((await readFile(join(input.stateRoot, "compose.yml"))).equals(composeBytes)).toBe(true);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(false);
    expect(readiness.events).toEqual(["ready:ordinary", "ready:native"]);
    expect(runner.calls.filter(({ args }) => args[1] === "exec" && args[6] === "ready").map(({ args }) => args[4]))
      .toEqual(["2".repeat(64), "1".repeat(64)]);
  });

  it("treats a missing established data volume as fatal before pull or mutation", async () => {
    // Given: installed state records established volumes but the native data volume is gone.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });
    const installBytes = await readFile(join(input.stateRoot, "install.json"));
    const composeBytes = await readFile(join(input.stateRoot, "compose.yml"));
    runner.nativeVolume = false;
    runner.calls.splice(0);

    // When: the installer checks the otherwise byte-identical deployment.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });

    // Then: the data-loss condition is explicit and nothing is pulled, probed, created, or started.
    await expect(action).rejects.toThrow(
      "established control-plane data volume 'dim-control-plane-native-git-data' is missing; refusing to recreate it"
    );
    expect(runner.calls.some(({ args }) => args[0] === "pull" || args[0] === "run"
      || args[1] === "create" || args.includes("up") || args[1] === "rm")).toBe(false);
    expect((await readFile(join(input.stateRoot, "install.json"))).equals(installBytes)).toBe(true);
    expect((await readFile(join(input.stateRoot, "compose.yml"))).equals(composeBytes)).toBe(true);
    expect(runner.nativeVolume).toBe(false);
    expect(runner.ordinaryVolume).toBe(true);
  });

  it.each(isolationRuntimeFaults)("rejects prohibited %s before no-op readiness or mutation", async (fault) => {
    // Given: an installed bundle whose running topology acquires one prohibited field.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });
    runner.calls.splice(0);
    runner.runtimeInspectionFault = fault;

    // When: byte-identical input enters no-op validation.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });

    // Then: topology drift stops before readiness and no Docker mutation begins.
    await expect(action).rejects.toThrow();
    expect(runner.calls.some(({ args }) => args[1] === "exec")).toBe(false);
    expect(runner.calls.some(({ args }) => args.includes("up") || args[1] === "create" || args[1] === "rm")).toBe(false);
  });

  it("probes candidate and prior state before replacing ordinary then native and publishes a new generation", async () => {
    // Given: a healthy prior generation and changed digest-pinned service images.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const readiness = new ObservingReadiness(input.stateRoot, runner);
    const prior = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });
    readiness.expectInstalled = true;
    await writeChangedImages(input.configPath);
    runner.calls.splice(0);
    readiness.events.splice(0);

    // When: the unified installer updates the running bundle.
    const updated = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });

    // Then: compatibility probes precede ordinary-first replacement and publication succeeds.
    const probes = runner.calls.filter(({ args }) => args[0] === "run"
      && (args.includes("compatibility") || args.includes("check-state")));
    const firstReplacement = runner.calls.findIndex(({ args }) => args.includes("--force-recreate"));
    expect(probes).toHaveLength(8);
    expect(runner.calls.slice(0, firstReplacement).filter(({ args }) => args[0] === "run")).toEqual(
      expect.arrayContaining(probes));
    expect(runner.calls.filter(({ args }) => args.includes("--force-recreate")).map(({ args }) => args.at(-1)))
      .toEqual(["ordinary-ci", "native-git"]);
    expect(updated.record.generationId).not.toBe(prior.record.generationId);
    expect(await readdir(join(input.stateRoot, "generations"))).toHaveLength(2);
    expect(readiness.events).toEqual(["ready:ordinary", "ready:native"]);
    expect(runner.calls.filter(({ args }) => args[1] === "exec" && args[6] === "activate").map(({ args }) => args[4]))
      .toEqual(["2".repeat(64), "1".repeat(64)]);
  });

  it("performs a checked update when only published ports change", async () => {
    // Given: a healthy installation and a config changing only both published ports.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const readiness = new ObservingReadiness(input.stateRoot, runner);
    const allocate = deterministicRandom();
    const prior = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: allocate
    });
    const priorCompose = await readFile(join(input.stateRoot, "compose.yml"));
    await writeChangedPorts(input.configPath);
    runner.calls.splice(0);
    readiness.events.splice(0);
    readiness.expectInstalled = true;

    // When: the installer sees identical images and source bytes but changed publications.
    const updated = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: allocate
    });

    // Then: it runs checked update probes, replaces both services, and publishes a new generation.
    expect(runner.calls.filter(({ args }) => args[0] === "run"
      && (args.includes("compatibility") || args.includes("check-state")))).toHaveLength(8);
    expect(runner.calls.filter(({ args }) => args.includes("--force-recreate")).map(({ args }) => args.at(-1)))
      .toEqual(["ordinary-ci", "native-git"]);
    expect(updated.record.generationId).not.toBe(prior.record.generationId);
    expect(updated.record.composeSha256).not.toBe(prior.record.composeSha256);
    expect((await readFile(join(input.stateRoot, "compose.yml"))).equals(priorCompose)).toBe(false);
    expect(updated.record.nativeGitPublish).toEqual({ host: "127.0.0.1", port: 7543 });
    expect(updated.record.ordinaryCiPublish).toEqual({ host: "127.0.0.1", port: 7510 });
    expect(readiness.events).toEqual(["ready:ordinary", "ready:native"]);
  });

  it("uses restored prior container IDs and generation for rollback readiness after ports change", async () => {
    // Given: a healthy prior generation and a candidate changing images and published ports.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const readiness = new ObservingReadiness(input.stateRoot, runner);
    const prior = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });
    const priorInstall = await readFile(join(input.stateRoot, "install.json"));
    const priorCompose = await readFile(join(input.stateRoot, "compose.yml"));
    await writeChangedPorts(input.configPath, true);
    readiness.events.splice(0);
    runner.failReadinessEvent = "ready:native";
    readiness.expectInstalled = true;

    // When: candidate native readiness fails after both replacements.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom(),
      readinessPolicy: immediateReadinessDeadline
    });

    // Then: exact prior bytes/runtime return and readiness targets the restored prior containers.
    await expect(action).rejects.toThrow(/exact prior generation was restored/);
    expect((await readFile(join(input.stateRoot, "install.json"))).equals(priorInstall)).toBe(true);
    expect((await readFile(join(input.stateRoot, "compose.yml"))).equals(priorCompose)).toBe(true);
    expect(runner.nativeRuntime?.image).toBe(prior.record.nativeGitImage);
    expect(runner.ordinaryRuntime?.image).toBe(prior.record.ordinaryCiImage);
    expect(runner.nativeRuntime?.publishPort).toBe(7443);
    expect(runner.ordinaryRuntime?.publishPort).toBe(7410);
    expect(runner.nativeVolume && runner.ordinaryVolume).toBe(true);
    expect(await readdir(join(input.stateRoot, "generations"))).toHaveLength(2);
    expect(readiness.events).toEqual(["ready:ordinary", "ready:native", "ready:ordinary", "ready:native"]);
    const rollbackExec = runner.calls.filter(({ args }) => args[1] === "exec").map(({ args }) => args.at(-1));
    expect(rollbackExec.slice(-2)).toEqual([prior.record.generationId, prior.record.generationId]);
  });

  it("restores exact prior services and root bytes after candidate native readiness failure", async () => {
    // Given: a healthy prior generation, changed images, and one injected post-mutation failure.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const readiness = new ObservingReadiness(input.stateRoot, runner);
    const prior = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });
    const priorInstall = await readFile(join(input.stateRoot, "install.json"));
    const priorCompose = await readFile(join(input.stateRoot, "compose.yml"));
    await writeChangedImages(input.configPath);
    readiness.events.splice(0);
    runner.failReadinessEvent = "ready:native";
    readiness.expectInstalled = true;

    // When: the injected failure occurs after candidate replacement.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom(),
      readinessPolicy: immediateReadinessDeadline
    });

    // Then: rollback restores prior bytes/images and activation while retaining failed candidate evidence.
    await expect(action).rejects.toThrow(/exact prior generation was restored/);
    expect((await readFile(join(input.stateRoot, "install.json"))).equals(priorInstall)).toBe(true);
    expect((await readFile(join(input.stateRoot, "compose.yml"))).equals(priorCompose)).toBe(true);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(false);
    expect(await readdir(join(input.stateRoot, "generations"))).toHaveLength(2);
    expect(runner.nativeRuntime?.image).toBe(prior.record.nativeGitImage);
    expect(runner.ordinaryRuntime?.image).toBe(prior.record.ordinaryCiImage);
    expect(runner.nativeVolume && runner.ordinaryVolume).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === "volume" && args[1] === "rm")).toBe(false);
    expect(readiness.events).toEqual(["ready:ordinary", "ready:native", "ready:ordinary", "ready:native"]);
    const execGenerations = runner.calls.filter(({ args }) => args[1] === "exec").map(({ args }) => args.at(-1));
    expect(execGenerations.slice(-2)).toEqual([prior.record.generationId, prior.record.generationId]);
  });

  it("halts fail-closed with both generations and journal when rollback replacement fails", async () => {
    // Given: a candidate native-readiness failure followed by a rollback ordinary replacement failure.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner,
      randomBytes: deterministicRandom()
    });
    await writeChangedImages(input.configPath);
    runner.failReplacementNumber = 3;
    new ObservingReadiness(input.stateRoot, runner, false, "ready:native", true);

    // When: automatic rollback cannot safely replace the first prior service.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom(),
      readinessPolicy: immediateReadinessDeadline
    });

    // Then: recovery evidence and data volumes remain without broad deletion.
    await expect(action).rejects.toThrow(/update and rollback failed/);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(true);
    expect(await readdir(join(input.stateRoot, "generations"))).toHaveLength(2);
    expect(runner.nativeVolume && runner.ordinaryVolume).toBe(true);
    expect(runner.calls.some(({ args }) => args[0] === "volume" && args[1] === "rm")).toBe(false);
  });

  it("does not begin rollback when Docker mutation termination is uncertain", async () => {
    // Given: a healthy prior generation and a candidate replacement whose process tree cannot be proven stopped.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner,
      randomBytes: deterministicRandom()
    });
    await writeChangedImages(input.configPath);
    runner.calls.splice(0);
    runner.uncertainReplacementNumber = 1;

    // When: the first mutating replacement reports uncertain termination.
    const action = installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner,
      randomBytes: deterministicRandom()
    });

    // Then: the distinct incident escapes with journal evidence and no automatic rollback mutation.
    await expect(action).rejects.toMatchObject({ name: "ControlPlaneDockerUncertainError" });
    expect(runner.calls.filter(({ args }) => args.includes("--force-recreate"))).toHaveLength(1);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(true);
    expect(await readdir(join(input.stateRoot, "generations"))).toHaveLength(2);
  });
});
