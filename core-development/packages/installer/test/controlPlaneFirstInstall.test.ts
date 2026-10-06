import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installFirstControlPlane } from "../../../../core/packages/installer/src/controlPlaneInstall.js";
import { ControlPlaneInstallError } from "../../../../core/packages/installer/src/controlPlaneInstallError.js";
import { controlPlaneSecrets } from "./controlPlaneFixture.js";
import { ProbeFailureRunner } from "./controlPlaneFailureRunner.js";
import {
  FirstInstallRunner,
  isolationRuntimeFaults,
  type RuntimeFault
} from "./controlPlaneInstallFixture.js";
import {
  deterministicRandom,
  directoryDigest,
  exists,
  installFixture,
  immediateReadinessDeadline,
  ObservingReadiness
} from "./controlPlaneInstallTestSupport.js";

describe("first control-plane installation", () => {
  it("runs the absent-state transaction in strict order and returns only after both activations", async () => {
    // Given: valid private operator sources, an absent Docker project, and observed readiness execs.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const readiness = new ObservingReadiness(input.stateRoot, runner);

    // When: the callable first-install transaction runs.
    const installed = await installFirstControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });

    // Then: services start ordinary-first and publication follows exact topology verification.
    expect(installed.record.generationId).toMatch(/^[0-9a-f]{64}$/);
    expect(readiness.events).toEqual(["ready:ordinary", "ready:native"]);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(false);
    expect(runner.composeMode).toBe(0o600);
    for (const secret of Object.values(controlPlaneSecrets)) expect(runner.composeText).not.toContain(secret);
    const significant = runner.calls.map(({ args }) => args).filter((args) =>
      args.includes("config") || args[1] === "create" || args.includes("up"));
    expect(significant.map(commandKind)).toEqual([
      "compose-config", "network-create", "volume-native", "volume-ordinary", "up-ordinary", "up-native"
    ]);
    expect(runner.calls.filter(({ args }) => args[1] === "exec" && args[6] === "activate").map(({ args }) => args[4]))
      .toEqual(["2".repeat(64), "1".repeat(64)]);
    for (const call of runner.calls) {
      for (const secret of Object.values(controlPlaneSecrets)) expect(call.args.join("\0")).not.toContain(secret);
    }
  });

  it("does not create Docker resources when image preflight fails", async () => {
    // Given: valid staged sources but a failing read-only image probe.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    runner.failImageProbe = true;

    // When: preflight refuses the candidate.
    const action = installFirstControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner,
      randomBytes: deterministicRandom()
    });

    // Then: no resource, activation token, or installed record is created.
    await expect(action).rejects.toThrow(/preflight|probe/i);
    expect(runner.calls.some(({ args }) => args[1] === "create" || args.includes("up"))).toBe(false);
    expect(await exists(join(input.stateRoot, "install.json"))).toBe(false);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(false);
    expect(await readdir(join(input.stateRoot, "generations"))).toEqual([]);
  });

  it.each([
    ["check-config", "native-git configuration"],
    ["check-bundle-config", "bundle configuration"]
  ] as const)("retains only successful pull references when %s fails", async (command, stage) => {
    // Given: both reviewed images pull before a hostile image-local probe failure.
    const input = await installFixture();
    const hostile = `hostile-${controlPlaneSecrets.query}`;
    const runner = new ProbeFailureRunner({ kind: "probe", command, output: hostile });

    // When: preflight rejects after the successful pulls.
    const error = await installFirstControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    }).catch((failure: unknown) => failure);

    // Then: only validated config refs and a fixed stage cross the failure boundary.
    expect(error).toBeInstanceOf(ControlPlaneInstallError);
    if (!(error instanceof ControlPlaneInstallError) || error.details?.kind !== "preflight") {
      throw new TypeError("expected typed control-plane preflight details");
    }
    expect(error).toMatchObject({
      details: {
        kind: "preflight",
        stage,
        pulledRefs: [
          `registry.example/dim/native-git@sha256:${"a".repeat(64)}`,
          `registry.example/dim/ordinary-ci@sha256:${"b".repeat(64)}`
        ]
      }
    });
    expect(JSON.stringify(error)).not.toContain(hostile);
    expect(runner.calls.filter(({ args }) => args[0] === "pull").map(({ args }) => args[1])).toEqual(
      error.details.pulledRefs
    );
  });

  it("distinguishes a failed pull from confirmed cache presence", async () => {
    // Given: native pulls successfully but the ordinary pull fails with hostile daemon output.
    const input = await installFixture();
    const runner = new ProbeFailureRunner({
      kind: "pull", image: "ordinary-ci", output: `hostile-${controlPlaneSecrets.identity}`
    });

    // When: image pulling stops before metadata or configuration probes.
    const error = await installFirstControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    }).catch((failure: unknown) => failure);

    // Then: native is confirmed pulled while ordinary is reported only as possibly partial.
    if (!(error instanceof ControlPlaneInstallError) || error.details?.kind !== "preflight") {
      throw new TypeError("expected typed control-plane preflight details");
    }
    expect(error.details).toEqual({
      kind: "preflight",
      stage: "ordinary-ci image pull",
      pulledRefs: [`registry.example/dim/native-git@sha256:${"a".repeat(64)}`],
      incompletePullRef: `registry.example/dim/ordinary-ci@sha256:${"b".repeat(64)}`
    });
    expect(JSON.stringify(error)).not.toContain(controlPlaneSecrets.identity);
  });

  it("rejects existing owned Docker resources before pulling images", async () => {
    // Given: installed-state is absent while the complete named Docker project already exists.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    runner.network = true;
    runner.nativeVolume = true;
    runner.ordinaryVolume = true;
    runner.nativeContainer = true;
    runner.ordinaryContainer = true;

    // When: first installation classifies the existing resource boundary.
    const action = installFirstControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner,
      randomBytes: deterministicRandom()
    });

    // Then: mismatch is rejected without image-cache or one-shot probe mutation.
    await expect(action).rejects.toThrow(/preflight failed before resource mutation/);
    expect(runner.calls.some(({ args }) => args[0] === "pull" || args[0] === "run")).toBe(false);
  });

  it.each(["network", "volume"] as const)("rejects a same-driver foreign %s returned by create before starting a service", async (resource) => {
    // Given: Docker create reuses the requested name with foreign ownership labels.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    if (resource === "network") runner.foreignNetworkOnCreate = true;
    else runner.foreignNativeVolumeOnCreate = true;

    // When: first installation establishes its named resources.
    const action = installFirstControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner,
      randomBytes: deterministicRandom()
    });

    // Then: the returned name is not accepted as ownership proof and no service starts.
    await expect(action).rejects.toThrow(/first control-plane installation failed/);
    expect(runner.calls.some(({ args }) => args.includes("up"))).toBe(false);
  });

  it.each(["command", "image", "mount", "port", "user", "security"] satisfies readonly RuntimeFault[])(
    "rejects wrong %s runtime identity after first service start and before readiness",
    async (fault) => {
      // Given: Compose reports success but Docker inspection exposes a wrong runtime field.
      const input = await installFixture();
      const runner = new FirstInstallRunner();
      runner.runtimeFaultAt = { start: 1, kind: fault };
      const readiness = new ObservingReadiness(input.stateRoot, runner);

      // When: the first ordinary service is started.
      const action = installFirstControlPlane({
        configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
      });

      // Then: exact runtime inspection fails before readiness or publication.
      await expect(action).rejects.toThrow(/first control-plane installation failed/);
      expect(readiness.events).toEqual([]);
      expect(await exists(join(input.stateRoot, "install.json"))).toBe(false);
    }
  );

  it.each(isolationRuntimeFaults)("rejects prohibited %s before first readiness", async (fault) => {
    // Given: Compose starts the ordinary service with one prohibited device or namespace field.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    runner.runtimeFaultAt = { start: 1, kind: fault };
    const readiness = new ObservingReadiness(input.stateRoot, runner);

    // When: exact runtime topology is inspected after service creation.
    const action = installFirstControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });

    // Then: topology drift is rejected before readiness or installed-state publication.
    await expect(action).rejects.toThrow(/first control-plane installation failed/);
    expect(readiness.events).toEqual([]);
    expect(await exists(join(input.stateRoot, "install.json"))).toBe(false);
  });

  it("retains volumes and immutable generation evidence when first readiness fails", async () => {
    // Given: a failure at the first authenticated readiness request.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const readiness = new ObservingReadiness(input.stateRoot, runner, true);

    // When: ordinary readiness fails after resources and its container exist.
    const action = installFirstControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom(),
      readinessPolicy: immediateReadinessDeadline
    });

    // Then: owned containers/network are removed while volumes and generation evidence remain.
    await expect(action).rejects.toThrow(/first control-plane installation failed/);
    expect(runner.nativeVolume && runner.ordinaryVolume).toBe(true);
    expect(runner.network || runner.nativeContainer || runner.ordinaryContainer).toBe(false);
    expect(runner.calls.some(({ args }) => args[0] === "volume" && args[1] === "rm")).toBe(false);
    expect(runner.calls.some(({ args }) => args[0] === "compose" && args.includes("down"))).toBe(false);
    const ordinaryRemoval = runner.calls.findIndex(({ args }) => args[0] === "container" && args[1] === "rm");
    const ordinaryCheck = runner.calls.findLastIndex(({ args }, index) => index < ordinaryRemoval
      && args[0] === "container" && args[1] === "inspect" && args[2] === "dim-control-plane-ordinary-ci-1");
    expect(ordinaryCheck).toBeGreaterThan(-1);
    expect(runner.calls[ordinaryRemoval]?.args.at(-1)).toBe("2".repeat(64));
    const networkRemoval = runner.calls.findIndex(({ args }) => args[0] === "network" && args[1] === "rm");
    const networkCheck = runner.calls.findLastIndex(({ args }, index) => index < networkRemoval
      && args[0] === "network" && args[1] === "inspect" && args[2] === "dim-control-plane");
    expect(networkCheck).toBeGreaterThan(-1);
    expect(runner.calls[networkRemoval]?.args.at(-1)).toBe("c".repeat(64));
    const generationIds = await readdir(join(input.stateRoot, "generations"));
    const generationPath = join(input.stateRoot, "generations", generationIds[0] ?? "missing");
    expect(generationIds).toHaveLength(1);
    expect(await directoryDigest(generationPath)).toBe(readiness.generationDigestAtFailure);
    expect(await readFile(join(input.stateRoot, "transaction.json"), "utf8")).toContain('"phase":"failed-first-install"');
    expect(await exists(join(input.stateRoot, "install.json"))).toBe(false);
  });

  it("does not clean up first-install resources when Docker mutation termination is uncertain", async () => {
    // Given: a first install whose first service-start process may remain active.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    runner.uncertainStartNumber = 1;

    // When: the mutating Docker command reports uncertain termination.
    const action = installFirstControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner,
      randomBytes: deterministicRandom()
    });

    // Then: no cleanup command overlaps the possible mutation and journal evidence remains.
    await expect(action).rejects.toMatchObject({ name: "ControlPlaneDockerUncertainError" });
    expect(runner.calls.filter(({ args }) => args.includes("up"))).toHaveLength(1);
    expect(runner.calls.some(({ args }) => args[1] === "rm")).toBe(false);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(true);
    expect(await readdir(join(input.stateRoot, "generations"))).toHaveLength(1);
  });

  it("does not clean up when readiness exec termination is uncertain", async () => {
    // Given
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    runner.uncertainReadinessEvent = "ready:ordinary";

    // When
    const action = installFirstControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: deterministicRandom()
    });

    // Then
    await expect(action).rejects.toMatchObject({ name: "ControlPlaneDockerUncertainError" });
    expect(runner.ordinaryContainer).toBe(true);
    expect(runner.calls.some(({ args }) => args[1] === "rm")).toBe(false);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(true);
  });
});

function commandKind(args: readonly string[]): string {
  if (args.includes("config")) return "compose-config";
  if (args[0] === "network") return "network-create";
  if (args[0] === "volume") return args.at(-1)?.includes("native-git") ? "volume-native" : "volume-ordinary";
  return args.at(-1) === "ordinary-ci" ? "up-ordinary" : "up-native";
}
