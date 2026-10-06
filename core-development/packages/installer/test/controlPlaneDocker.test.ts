import { describe, expect, it } from "vitest";
import {
  ControlPlaneDockerError,
  preflightControlPlaneDocker
} from "../../../../core/packages/installer/src/controlPlaneDocker.js";
import {
  AbsentRunner,
  DigestMismatchRunner,
  ExtraAttachmentRunner,
  ExtraServiceRunner,
  ExtraVolumeUserRunner,
  FailedProbeRunner,
  ForeignLabelRunner,
  MalformedMetadataRunner,
  NoisyProbeRunner,
  OwnedRunner,
  PartialRunner,
  WrongUserRunner,
  bundleProbeArgs,
  config,
  nativeImage,
  ordinaryImage,
  serviceProbeArgs,
  snapshots
} from "./controlPlaneDockerFixture.js";

describe("control-plane Docker preflight", () => {
  it("rejects missing Compose v2 before inspecting or mutating resources", async () => {
    // Given
    const calls: string[][] = [];
    const runner = {
      async run(command: { readonly args: readonly string[] }) {
        calls.push([...command.args]);
        return { exitCode: 1, stdout: "", stderr: "docker: 'compose' is not a docker command.\n" };
      }
    };

    // When
    const action = preflightControlPlaneDocker(runner, { config, snapshots });

    // Then
    await expect(action).rejects.toThrow("Docker Compose v2 or newer is required");
    expect(calls).toEqual([["compose", "version", "--short"]]);
  });

  it("inspects a wholly absent project before pulling and runs three hardened probes", async () => {
    // Given
    const runner = new AbsentRunner();

    // When
    const state = await preflightControlPlaneDocker(runner, { config, snapshots });

    // Then
    expect(state).toEqual({ kind: "absent" });
    const mutationIndex = runner.calls.findIndex(({ args }) => args[0] === "pull" || args[0] === "run");
    expect(mutationIndex).toBeGreaterThan(0);
    expect(runner.calls.slice(0, mutationIndex).every(({ args }) => !["pull", "run"].includes(args[0] ?? ""))).toBe(true);
    expect(runner.calls.filter(({ args }) => args[0] === "pull").map(({ args }) => args)).toEqual([
      ["pull", nativeImage],
      ["pull", ordinaryImage]
    ]);
    expect(runner.calls.filter(({ args }) => args[0] === "run").map(({ args }) => args)).toEqual([
      serviceProbeArgs({ user: "10001:10001", image: nativeImage, source: "/staged/native.json" }),
      serviceProbeArgs({ user: "10002:10002", image: ordinaryImage, source: "/staged/ordinary.json" }),
      bundleProbeArgs()
    ]);
    expect(runner.calls.every((call) => call.timeoutMilliseconds > 0 && call.maximumOutputBytes <= 65_536)).toBe(true);
  });

  it("accepts only a complete exact-owned Compose project", async () => {
    // Given
    const runner = new OwnedRunner();

    // When
    const state = await preflightControlPlaneDocker(runner, { config, snapshots });

    // Then
    expect(state).toEqual({
      kind: "owned",
      nativeGitContainerId: "1".repeat(64),
      ordinaryCiContainerId: "2".repeat(64)
    });
  });

  it.each([
    ["partial resources", new PartialRunner()],
    ["foreign DIM labels", new ForeignLabelRunner()],
    ["an extra Compose service", new ExtraServiceRunner()],
    ["an extra network attachment", new ExtraAttachmentRunner()],
    ["an extra volume user", new ExtraVolumeUserRunner()]
  ])("rejects %s before pull or run", async (_label, runner) => {
    // Given / When
    const action = preflightControlPlaneDocker(runner, { config, snapshots });

    // Then
    await expect(action).rejects.toBeInstanceOf(ControlPlaneDockerError);
    expect(runner.calls.some(({ args }) => args[0] === "pull" || args[0] === "run")).toBe(false);
  });

  it.each([
    ["digest mismatch", new DigestMismatchRunner()],
    ["malformed image metadata", new MalformedMetadataRunner()],
    ["wrong image user", new WrongUserRunner()],
    ["failed probe", new FailedProbeRunner()],
    ["redirecting probe output", new NoisyProbeRunner()]
  ])("rejects %s with no config value in the error", async (_label, runner) => {
    // Given / When
    const action = preflightControlPlaneDocker(runner, { config, snapshots });

    // Then
    await expect(action).rejects.toSatisfy((error: unknown) =>
      error instanceof ControlPlaneDockerError
      && !error.message.includes("native-main")
      && !error.message.includes("ordinary-main"));
  });

  it("rejects mutable operator paths before Docker inspection", async () => {
    // Given
    const runner = new AbsentRunner();

    // When
    const action = preflightControlPlaneDocker(runner, {
      config,
      snapshots: { nativeGit: config.nativeGit.configFile, ordinaryCi: snapshots.ordinaryCi }
    });

    // Then
    await expect(action).rejects.toThrow(/staged snapshot/);
    expect(runner.calls).toHaveLength(0);
  });
});
