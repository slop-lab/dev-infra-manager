import { describe, expect, it } from "vitest";
import type {
  ControlPlaneDockerCommand,
  ControlPlaneDockerCommandResult
} from "../../../../core/packages/installer/src/controlPlaneDockerTypes.js";
import { installControlPlane } from "../../../../core/packages/installer/src/controlPlaneInstall.js";
import { FirstInstallRunner } from "./controlPlaneInstallFixture.js";
import {
  deterministicRandom,
  installFixture,
  writeChangedImages,
  writeChangedPorts
} from "./controlPlaneInstallTestSupport.js";

describe("control-plane published-address preflight", () => {
  it("rejects an occupied first-install address before persistent Docker mutation", async () => {
    // Given: an otherwise valid candidate whose native address is occupied in the Docker daemon.
    const input = await installFixture();
    const runner = new PortAwareRunner();
    runner.occupiedPublishedAddresses.add("127.0.0.1:7443:8080");

    // When: the installer runs its preflight.
    const action = installControlPlane({
      configPath: input.configPath,
      stateRoot: input.stateRoot,
      runner,
      randomBytes: deterministicRandom()
    });

    // Then: publication is refused before any fixed resource or service mutation.
    await expect(action).rejects.toThrow(/preflight failed before resource mutation/);
    expect(runner.calls.some(({ args }) => args[0] === "network" && args[1] === "create")).toBe(false);
    expect(runner.calls.some(({ args }) => args[0] === "volume" && args[1] === "create")).toBe(false);
    expect(runner.calls.some(({ args }) => args[0] === "compose" && args.includes("up"))).toBe(false);
  });

  it("admits free first-install addresses after candidate image probes", async () => {
    // Given: an absent bundle and two free candidate addresses.
    const input = await installFixture();
    const runner = new PortAwareRunner();

    // When: the first installation completes.
    await installControlPlane({
      configPath: input.configPath,
      stateRoot: input.stateRoot,
      runner,
      randomBytes: deterministicRandom()
    });

    // Then: both address probes follow config probes and precede fixed resource creation.
    const publications = publishProbeCalls(runner);
    expect(publications.map(({ args }) => optionValue(args, "--publish"))).toEqual([
      "127.0.0.1:7443:8080",
      "127.0.0.1:7410:8080"
    ]);
    expect(publications.every(({ args }) => !args.includes("--mount")
      && !args.some((value) => value.includes("token") || value.includes("docker.sock")))).toBe(true);
    const lastConfigProbe = runner.calls.findLastIndex(({ args }) => args[0] === "run" && args.includes("check-bundle-config"));
    const firstPublication = runner.calls.findIndex(({ args }) => args.includes("--publish"));
    const firstResourceCreate = runner.calls.findIndex(({ args }) => args[1] === "create");
    expect(lastConfigProbe).toBeLessThan(firstPublication);
    expect(firstPublication).toBeLessThan(firstResourceCreate);
  });

  it("does not probe exact current-owned addresses on no-op or image-only update", async () => {
    // Given: a healthy owned installation whose published addresses would conflict with disposable probes.
    const input = await installFixture();
    const runner = new PortAwareRunner();
    const allocate = deterministicRandom();
    await installControlPlane({
      configPath: input.configPath,
      stateRoot: input.stateRoot,
      runner,
      randomBytes: allocate
    });
    runner.occupiedPublishedAddresses.add("127.0.0.1:7443:8080");
    runner.occupiedPublishedAddresses.add("127.0.0.1:7410:8080");
    runner.calls.splice(0);

    // When: exact-input no-op and then an image-only update are installed.
    await installControlPlane({
      configPath: input.configPath,
      stateRoot: input.stateRoot,
      runner,
      randomBytes: allocate
    });
    await writeChangedImages(input.configPath);
    await installControlPlane({
      configPath: input.configPath,
      stateRoot: input.stateRoot,
      runner,
      randomBytes: deterministicRandom()
    });

    // Then: neither path probes addresses already verified as this bundle's exact bindings.
    expect(publishProbeCalls(runner)).toHaveLength(0);
  });

  it("probes only newly selected addresses before a port-only update", async () => {
    // Given: a healthy bundle and a config changing only both published ports.
    const input = await installFixture();
    const runner = new PortAwareRunner();
    const allocate = deterministicRandom();
    await installControlPlane({
      configPath: input.configPath,
      stateRoot: input.stateRoot,
      runner,
      randomBytes: allocate
    });
    await writeChangedPorts(input.configPath);
    runner.calls.splice(0);

    // When: the port-only update completes.
    await installControlPlane({
      configPath: input.configPath,
      stateRoot: input.stateRoot,
      runner,
      randomBytes: allocate
    });

    // Then: only the two candidate addresses are probed before either service replacement.
    const publications = publishProbeCalls(runner);
    expect(publications.map(({ args }) => optionValue(args, "--publish"))).toEqual([
      "127.0.0.1:7543:8080",
      "127.0.0.1:7510:8080"
    ]);
    const lastPublication = runner.calls.findLastIndex(({ args }) => args.includes("--publish"));
    const firstReplacement = runner.calls.findIndex(({ args }) => args.includes("--force-recreate"));
    expect(lastPublication).toBeLessThan(firstReplacement);
  });

  it("rejects an occupied changed address before replacing either owned service", async () => {
    // Given: a healthy bundle and a port-only candidate whose new native address is occupied.
    const input = await installFixture();
    const runner = new PortAwareRunner();
    const allocate = deterministicRandom();
    await installControlPlane({
      configPath: input.configPath,
      stateRoot: input.stateRoot,
      runner,
      randomBytes: allocate
    });
    await writeChangedPorts(input.configPath);
    runner.occupiedPublishedAddresses.add("127.0.0.1:7543:8080");
    runner.calls.splice(0);

    // When: the checked update reaches daemon publication preflight.
    const action = installControlPlane({
      configPath: input.configPath,
      stateRoot: input.stateRoot,
      runner,
      randomBytes: allocate
    });

    // Then: neither owned service is replaced.
    await expect(action).rejects.toThrow(/preflight failed before resource mutation/);
    expect(runner.calls.some(({ args }) => args.includes("--force-recreate"))).toBe(false);
    expect(runner.nativeRuntime?.publishPort).toBe(7443);
    expect(runner.ordinaryRuntime?.publishPort).toBe(7410);
  });
});

class PortAwareRunner extends FirstInstallRunner {
  readonly occupiedPublishedAddresses = new Set<string>();

  override async run(command: ControlPlaneDockerCommand): Promise<ControlPlaneDockerCommandResult> {
    const published = optionValue(command.args, "--publish");
    if (command.args[0] === "run" && published !== undefined && this.occupiedPublishedAddresses.has(published)) {
      this.calls.push(command);
      return { exitCode: 125, stdout: "", stderr: "port is already allocated" };
    }
    return await super.run(command);
  }
}

function publishProbeCalls(runner: FirstInstallRunner) {
  return runner.calls.filter(({ args }) => args[0] === "run" && args.includes("--publish"));
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}
