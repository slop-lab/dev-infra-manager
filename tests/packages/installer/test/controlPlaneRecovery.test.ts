import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installControlPlane,
  installFirstControlPlane,
  rollForwardControlPlane
} from "../../../../core/packages/installer/src/controlPlaneInstall.js";
import { FirstInstallRunner } from "./controlPlaneInstallFixture.js";
import {
  deterministicRandom,
  directoryDigest,
  exists,
  immediateReadinessDeadline,
  installFixture,
  writeChangedImages,
  writeChangedPorts
} from "./controlPlaneInstallTestSupport.js";

describe("control-plane exact roll-forward recovery", () => {
  it("recovers the exact candidate after multiple prior successful generations without adopting history", async () => {
    // Given: A and B were successfully installed, then C activation failed.
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    const allocate = deterministicRandom();
    const first = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: allocate
    });
    await writeChangedImages(input.configPath);
    const second = await installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: allocate
    });
    await writeChangedPorts(input.configPath);
    runner.failActivationService = "ordinary-ci";
    await expect(installControlPlane({
      configPath: input.configPath, stateRoot: input.stateRoot, runner, randomBytes: allocate
    })).rejects.toThrow(/activation outcome is uncertain/);
    const retained = await retainedEvidence(input.stateRoot, runner);
    const historical = [first.record.generationId, second.record.generationId].sort();
    const beforeHistory = await Promise.all(historical.map((id) =>
      directoryDigest(join(input.stateRoot, "generations", id))));
    runner.calls.splice(0);

    // When: the operator explicitly names only C for roll-forward.
    const recovered = await rollForwardControlPlane({
      stateRoot: input.stateRoot, expectedGenerationId: retained.generationId, runner
    });

    // Then: C is active, A/B remain passive immutable evidence, and no resource was replaced.
    expect(recovered.record.generationId).toBe(retained.generationId);
    await expectExactCandidatePreserved(retained);
    expect(await readdir(join(input.stateRoot, "generations"))).toEqual([...historical, retained.generationId].sort());
    expect(await Promise.all(historical.map((id) =>
      directoryDigest(join(input.stateRoot, "generations", id))))).toEqual(beforeHistory);
    expect(await exists(join(input.stateRoot, "transaction.json"))).toBe(false);
    expect(mutationCalls(runner)).toEqual([]);
    expect(activationCalls(runner)).toEqual(["2".repeat(64), "1".repeat(64)]);
  });

  it.each(["ordinary-ci", "native-git"] as const)(
    "recovers the exact retained update after %s activation fails without replacing resources or rewriting data",
    async (service) => {
      // Given
      const retained = await retainedUpdate({ activationFailure: service });

      // When
      const recovered = await rollForwardControlPlane({
        stateRoot: retained.stateRoot,
        expectedGenerationId: retained.generationId,
        runner: retained.runner
      });

      // Then
      expect(recovered.record.generationId).toBe(retained.generationId);
      await expectExactCandidatePreserved(retained);
      expect(await exists(join(retained.stateRoot, "transaction.json"))).toBe(false);
      expect(mutationCalls(retained.runner)).toEqual([]);
      expect(activationCalls(retained.runner)).toEqual(["2".repeat(64), "1".repeat(64)]);
    }
  );

  it("recovers after post-activation journal completion fails without replacing resources or rewriting data", async () => {
    // Given
    const retained = await retainedUpdate({ completionFailure: true });
    retained.runner.failCompletionAfterActivation = false;
    await chmod(join(retained.stateRoot, "transaction.json"), 0o600);

    // When
    await rollForwardControlPlane({
      stateRoot: retained.stateRoot,
      expectedGenerationId: retained.generationId,
      runner: retained.runner
    });

    // Then
    await expectExactCandidatePreserved(retained);
    expect(await exists(join(retained.stateRoot, "transaction.json"))).toBe(false);
    expect(mutationCalls(retained.runner)).toEqual([]);
  });

  it("recovers the exact retained first installation after activation fails", async () => {
    // Given
    const input = await installFixture();
    const runner = new FirstInstallRunner();
    runner.failActivationService = "ordinary-ci";
    await expect(installFirstControlPlane({
      configPath: input.configPath,
      stateRoot: input.stateRoot,
      runner,
      randomBytes: deterministicRandom()
    })).rejects.toThrow(/activation outcome is uncertain/);
    const retained = await retainedEvidence(input.stateRoot, runner);
    runner.calls.splice(0);

    // When
    await rollForwardControlPlane({
      stateRoot: input.stateRoot,
      expectedGenerationId: retained.generationId,
      runner
    });

    // Then
    await expectExactCandidatePreserved(retained);
    expect(await readdir(join(input.stateRoot, "generations"))).toEqual([retained.generationId]);
    expect(mutationCalls(runner)).toEqual([]);
  });

  it.each([
    ["wrong phase", async (retained: RetainedEvidence) => mutateJournal(retained, { phase: "generation" })],
    ["malformed journal", async (retained: RetainedEvidence) => writeFile(join(retained.stateRoot, "transaction.json"), "{\n")],
    ["malformed snapshot", async (retained: RetainedEvidence) => {
      const path = join(retained.stateRoot, "generations", retained.generationId, "native-git.json");
      await chmod(path, 0o600);
      await writeFile(path, "{}\n");
      await chmod(path, 0o444);
    }],
    ["malformed Compose", async (retained: RetainedEvidence) => writeFile(join(retained.stateRoot, "compose.yml"), "services: {}\n")]
  ] as const)("refuses %s with the journal intact and no activation or resource mutation", async (_case, corrupt) => {
    // Given
    const retained = await retainedUpdate({ activationFailure: "ordinary-ci" });
    await corrupt(retained);
    const journal = await readFile(join(retained.stateRoot, "transaction.json"));

    // When
    const action = rollForwardControlPlane({
      stateRoot: retained.stateRoot,
      expectedGenerationId: retained.generationId,
      runner: retained.runner
    });

    // Then
    await expect(action).rejects.toThrow();
    expect((await readFile(join(retained.stateRoot, "transaction.json"))).equals(journal)).toBe(true);
    expect(activationCalls(retained.runner)).toEqual([]);
    expect(mutationCalls(retained.runner)).toEqual([]);
  });

  it("refuses the wrong requested generation before activation", async () => {
    // Given
    const retained = await retainedUpdate({ activationFailure: "ordinary-ci" });
    const journal = await readFile(join(retained.stateRoot, "transaction.json"));

    // When
    const action = rollForwardControlPlane({
      stateRoot: retained.stateRoot,
      expectedGenerationId: "f".repeat(64),
      runner: retained.runner
    });

    // Then
    await expect(action).rejects.toThrow(/journal schema or identity/);
    expect((await readFile(join(retained.stateRoot, "transaction.json"))).equals(journal)).toBe(true);
    expect(retained.runner.calls).toEqual([]);
  });

  it.each(["mixed runtime", "missing resource", "foreign resource", "failed readiness"] as const)(
    "refuses %s before activation and leaves the journal intact",
    async (fault) => {
      // Given
      const retained = await retainedUpdate({ activationFailure: "ordinary-ci" });
      if (fault === "mixed runtime" && retained.priorNativeRuntime !== undefined) {
        retained.runner.nativeRuntime = retained.priorNativeRuntime;
      }
      if (fault === "missing resource") retained.runner.nativeContainer = false;
      if (fault === "foreign resource") retained.runner.foreignNetworkOnCreate = true;
      if (fault === "failed readiness") retained.runner.failEveryReadiness = true;
      const journal = await readFile(join(retained.stateRoot, "transaction.json"));

      // When
      const action = rollForwardControlPlane({
        stateRoot: retained.stateRoot,
        expectedGenerationId: retained.generationId,
        runner: retained.runner,
        ...(fault === "failed readiness" ? { readinessPolicy: immediateReadinessDeadline } : {})
      });

      // Then
      await expect(action).rejects.toThrow();
      expect((await readFile(join(retained.stateRoot, "transaction.json"))).equals(journal)).toBe(true);
      expect(activationCalls(retained.runner)).toEqual([]);
      expect(mutationCalls(retained.runner)).toEqual([]);
    }
  );

  it("retains the journal and exact candidate when replayed activation fails", async () => {
    // Given
    const retained = await retainedUpdate({ activationFailure: "ordinary-ci" });
    retained.runner.failActivationService = "native-git";
    const journal = await readFile(join(retained.stateRoot, "transaction.json"));

    // When
    const action = rollForwardControlPlane({
      stateRoot: retained.stateRoot,
      expectedGenerationId: retained.generationId,
      runner: retained.runner
    });

    // Then
    await expect(action).rejects.toThrow(/activation failed/);
    expect((await readFile(join(retained.stateRoot, "transaction.json"))).equals(journal)).toBe(true);
    expect(mutationCalls(retained.runner)).toEqual([]);
    expect((await readFile(join(retained.stateRoot, "install.json"))).equals(retained.installBytes)).toBe(true);
    expect((await readFile(join(retained.stateRoot, "compose.yml"))).equals(retained.composeBytes)).toBe(true);
  });
});

type RetainedEvidence = {
  readonly stateRoot: string;
  readonly runner: FirstInstallRunner;
  readonly generationId: string;
  readonly installBytes: Buffer;
  readonly composeBytes: Buffer;
  readonly generationDigest: string;
  readonly priorNativeRuntime?: NonNullable<FirstInstallRunner["nativeRuntime"]>;
};

async function retainedUpdate(failure: {
  readonly activationFailure?: "native-git" | "ordinary-ci";
  readonly completionFailure?: true;
}): Promise<RetainedEvidence> {
  const input = await installFixture();
  const runner = new FirstInstallRunner();
  await installControlPlane({
    configPath: input.configPath,
    stateRoot: input.stateRoot,
    runner,
    randomBytes: deterministicRandom()
  });
  const priorNativeRuntime = runner.nativeRuntime;
  await writeChangedImages(input.configPath);
  runner.failActivationService = failure.activationFailure;
  runner.failCompletionAfterActivation = failure.completionFailure === true;
  await expect(installControlPlane({
    configPath: input.configPath,
    stateRoot: input.stateRoot,
    runner,
    randomBytes: deterministicRandom()
  })).rejects.toThrow(/activation outcome is uncertain/);
  const retained = await retainedEvidence(input.stateRoot, runner);
  runner.calls.splice(0);
  return { ...retained, ...(priorNativeRuntime === undefined ? {} : { priorNativeRuntime }) };
}

async function retainedEvidence(stateRoot: string, runner: FirstInstallRunner): Promise<RetainedEvidence> {
  const installBytes = await readFile(join(stateRoot, "install.json"));
  const installed: unknown = JSON.parse(installBytes.toString("utf8"));
  const generationId = typeof installed === "object" && installed !== null
    ? Reflect.get(installed, "generationId")
    : undefined;
  if (typeof generationId !== "string") throw new TypeError("retained fixture generation is missing");
  return {
    stateRoot,
    runner,
    generationId,
    installBytes,
    composeBytes: await readFile(join(stateRoot, "compose.yml")),
    generationDigest: await directoryDigest(join(stateRoot, "generations", generationId))
  };
}

async function expectExactCandidatePreserved(retained: RetainedEvidence): Promise<void> {
  expect((await readFile(join(retained.stateRoot, "install.json"))).equals(retained.installBytes)).toBe(true);
  expect((await readFile(join(retained.stateRoot, "compose.yml"))).equals(retained.composeBytes)).toBe(true);
  expect(await directoryDigest(join(retained.stateRoot, "generations", retained.generationId)))
    .toBe(retained.generationDigest);
}

async function mutateJournal(retained: RetainedEvidence, fields: Readonly<Record<string, unknown>>): Promise<void> {
  const path = join(retained.stateRoot, "transaction.json");
  const journal: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof journal !== "object" || journal === null || Array.isArray(journal)) {
    throw new TypeError("retained fixture journal is malformed");
  }
  await writeFile(path, `${JSON.stringify({ ...journal, ...fields })}\n`);
}

function activationCalls(runner: FirstInstallRunner): readonly string[] {
  return runner.calls
    .filter(({ args }) => args[0] === "container" && args[1] === "exec" && args[6] === "activate")
    .map(({ args }) => args[4] ?? "missing");
}

function mutationCalls(runner: FirstInstallRunner): readonly (readonly string[])[] {
  return runner.calls
    .map(({ args }) => args)
    .filter((args) => args.includes("up") || args[1] === "create" || args[1] === "rm");
}
