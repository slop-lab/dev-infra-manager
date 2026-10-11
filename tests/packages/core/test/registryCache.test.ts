import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTROL_NETWORK,
  ensureRegistryCache,
  REGISTRY_CACHE_CONTAINER,
  REGISTRY_CACHE_ENDPOINT,
  REGISTRY_CACHE_VOLUME,
  registryCacheContainerArgs,
  sysboxRegistryConfigArgs
} from "../../../../core/packages/core/src/registryCache.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { hostMirrorInspection } from "../../../../core/packages/core/src/hostMirrorOwnership.js";
import { claimTestGiteaService } from "./giteaServiceFixture.js";
import { hostLifecycleOptions, registryCacheInspect, TEST_HOST_MIRROR_OWNERSHIP } from "./hostLifecycleFixture.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";

const REGISTRY_CACHE_IMAGE = `registry.example/docker-cache@sha256:${"a".repeat(64)}`;

type InspectTarget = "network" | "volume" | "container";

class RegistryCacheRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly failingTarget: InspectTarget | undefined,
    private readonly failingResult: CommandResult | undefined
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[1] !== "inspect") return { command, args, stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === this.failingTarget && this.failingResult) {
      return { ...this.failingResult, command, args };
    }
    const stdout = args[0] === "container"
      ? registryCacheInspect(REGISTRY_CACHE_IMAGE)
      : args[0] === "network"
        ? `${hostMirrorInspection("control-network", TEST_HOST_MIRROR_OWNERSHIP)}\n`
        : `${hostMirrorInspection("registry-cache-data", TEST_HOST_MIRROR_OWNERSHIP)}\n`;
    return { command, args, stdout, stderr: "", exitCode: 0 };
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

function failedInspect(stderr: string): CommandResult {
  return { command: "docker", args: [], stdout: "", stderr, exitCode: 1 };
}

describe("registry cache", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "dim-registry-cache-test-"));
    await new LifecycleState(stateRoot).writeHostMirrorOwnership(TEST_HOST_MIRROR_OWNERSHIP);
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("denies production reconciliation before Docker when no host provider is enabled", async () => {
    // Given
    const runner = new RegistryCacheRunner(undefined, undefined);

    // When
    const { hostMirrorProvider: _provider, ...options } = hostLifecycleOptions(stateRoot);
    const reconciliation = ensureRegistryCache(runner, options);

    // Then
    await expect(reconciliation).rejects.toThrow(/requires one enabled host mirror provider/);
    expect(runner.calls).toEqual([]);
  });

  it("replaces the cache without exposing its ephemeral network address", async () => {
    // Given
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args): Promise<CommandResult> {
        calls.push([command, ...args]);
        const output = args[0] === "network"
          ? `${hostMirrorInspection("control-network", TEST_HOST_MIRROR_OWNERSHIP)}\n`
          : args[0] === "volume"
            ? `${hostMirrorInspection("registry-cache-data", TEST_HOST_MIRROR_OWNERSHIP)}\n`
            : args[0] === "container" && args[1] === "inspect"
              ? registryCacheInspect("registry@sha256:obsolete")
            : args.some((argument) => argument.includes(".NetworkSettings.Networks"))
              ? "172.18.0.9\n"
              : "";
        return { command, args, stdout: output, stderr: "", exitCode: 0 };
      },
      async runStreaming(): Promise<number> { return 0; }
    };

    // When
    const connection = await ensureRegistryCache(runner, stateRoot, REGISTRY_CACHE_IMAGE);

    // Then
    expect(connection).toBeUndefined();
    expect(calls.some((call) => call.some((argument) => argument.includes(".IPAddress")))).toBe(false);
    expect(calls).toContainEqual(["docker", "container", "rm", "--force", "registry-id"]);
    expect(calls.some((call) => call.includes("--network-alias") && call.includes(REGISTRY_CACHE_CONTAINER))).toBe(true);
  });

  it.each([
    {
      target: "network",
      diagnostic: `Error response from daemon: network ${CONTROL_NETWORK} not found`,
      mutation: ["docker", "network", "create"]
    },
    {
      target: "volume",
      diagnostic: `Error response from daemon: get ${REGISTRY_CACHE_VOLUME}: no such volume`,
      mutation: ["docker", "volume", "create"]
    },
    {
      target: "container",
      diagnostic: `Error response from daemon: No such container: ${REGISTRY_CACHE_CONTAINER}`,
      mutation: ["docker", "run", "--detach"]
    }
  ] satisfies readonly {
    readonly target: InspectTarget;
    readonly diagnostic: string;
    readonly mutation: readonly string[];
  }[])("creates a missing $target only for its type-specific not-found result", async ({ target, diagnostic, mutation }) => {
    // Given
    const runner = new RegistryCacheRunner(target, failedInspect(diagnostic));

    // When
    await ensureRegistryCache(runner, stateRoot, REGISTRY_CACHE_IMAGE);

    // Then
    expect(runner.calls.some((call) => mutation.every((argument, index) => call[index] === argument))).toBe(true);
  });

  it.each([
    { target: "network", diagnostic: "Cannot connect to the Docker daemon" },
    { target: "network", diagnostic: `Error response from daemon: no such volume: ${CONTROL_NETWORK}` },
    { target: "volume", diagnostic: "permission denied while trying to connect to the Docker daemon socket" },
    { target: "volume", diagnostic: `Error: No such container: ${REGISTRY_CACHE_VOLUME}` },
    { target: "container", diagnostic: "malformed inspect response" },
    { target: "container", diagnostic: "context deadline exceeded" },
    { target: "container", diagnostic: `Error response from daemon: network ${REGISTRY_CACHE_CONTAINER} not found` }
  ] satisfies readonly {
    readonly target: InspectTarget;
    readonly diagnostic: string;
  }[])("fails closed on a $target inspect error: $diagnostic", async ({ target, diagnostic }) => {
    // Given
    const runner = new RegistryCacheRunner(target, failedInspect(diagnostic));

    // When
    const ensure = ensureRegistryCache(runner, stateRoot, REGISTRY_CACHE_IMAGE);

    // Then
    await expect(ensure).rejects.toThrow(/inspect/);
    expect(runner.calls.every((call) => call[2] === "inspect")).toBe(true);
  });

  it("runs an internal pinned Docker Hub pull-through cache", () => {
    const providerImage = `registry.example/docker-cache@sha256:${"a".repeat(64)}`;
    const args = registryCacheContainerArgs(providerImage, TEST_HOST_MIRROR_OWNERSHIP);
    expect(REGISTRY_CACHE_ENDPOINT).toBe("dim-registry-cache:5000");
    expect(args).toEqual(expect.arrayContaining([
      "--name", REGISTRY_CACHE_CONTAINER,
      "--network", CONTROL_NETWORK,
      "--mount", `type=volume,source=${REGISTRY_CACHE_VOLUME},target=/var/lib/registry`,
      "--env", "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io",
      "--env", "REGISTRY_STORAGE_DELETE_ENABLED=true",
      providerImage
    ]));
    expect(args).not.toContain("--publish");
    expect(args).not.toContain("--add-host=registry-1.docker.io:127.0.0.1");
    expect(args).not.toContain("--add-host=auth.docker.io:127.0.0.1");
    expect(providerImage).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("rejects a foreign shared control network in managed-Gitea mode without mutation", async () => {
    // Given
    await claimTestGiteaService(stateRoot);
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        const stdout = args[0] === "network" && args[1] === "inspect"
          ? args.some((argument) => argument.includes("dim.service-id"))
            ? "true|foreign|foreign-service|network|foreign-resource\n"
            : "true\n"
          : args[0] === "volume" && args[1] === "inspect"
            ? `${hostMirrorInspection("registry-cache-data", TEST_HOST_MIRROR_OWNERSHIP)}\n`
            : registryCacheInspect(REGISTRY_CACHE_IMAGE);
        return { command, args, stdout, stderr: "", exitCode: 0 };
      },
      async runStreaming() { return 0; }
    };

    // When
    const reconciliation = ensureRegistryCache(runner, {
      ...hostLifecycleOptions(stateRoot),
      hostMirrorProvider: { dockerImage: REGISTRY_CACHE_IMAGE, aptImage: REGISTRY_CACHE_IMAGE }
    });

    // Then
    await expect(reconciliation).rejects.toThrow(/not managed by dim/);
  });

  it("does not replace a same-name cache with only the generic managed label", async () => {
    // Given
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        const stdout = args[0] === "container"
          ? `foreign-id|true||||true|registry.example/old@sha256:${"c".repeat(64)}\n`
          : args[0] === "network"
            ? `${hostMirrorInspection("control-network", TEST_HOST_MIRROR_OWNERSHIP)}\n`
            : `${hostMirrorInspection("registry-cache-data", TEST_HOST_MIRROR_OWNERSHIP)}\n`;
        return { command, args, stdout, stderr: "", exitCode: 0 };
      },
      async runStreaming() { return 0; }
    };

    // When
    const reconciliation = ensureRegistryCache(runner, stateRoot, REGISTRY_CACHE_IMAGE);

    // Then
    await expect(reconciliation).rejects.toThrow(/not managed by dim/);
    expect(calls.some((call) => call.includes("rm"))).toBe(false);
  });

  it("does not adopt or replace an owned cache with mismatched runtime configuration", async () => {
    // Given
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        const stdout = args[0] === "container"
          ? `registry-id|${hostMirrorInspection("registry-cache", TEST_HOST_MIRROR_OWNERSHIP)}|true|registry.example/old@sha256:${"c".repeat(64)}|bridge|bind:foreign:/var/lib/registry:true|[]|no\n`
          : args[0] === "network"
            ? `${hostMirrorInspection("control-network", TEST_HOST_MIRROR_OWNERSHIP)}\n`
            : `${hostMirrorInspection("registry-cache-data", TEST_HOST_MIRROR_OWNERSHIP)}\n`;
        return { command, args, stdout, stderr: "", exitCode: 0 };
      },
      async runStreaming() { return 0; }
    };

    // When
    const reconciliation = ensureRegistryCache(runner, stateRoot, REGISTRY_CACHE_IMAGE);

    // Then
    await expect(reconciliation).rejects.toThrow(/runtime configuration/);
    expect(calls.some((call) => call.includes("rm"))).toBe(false);
  });

  it("writes the Sysbox daemon mirror into its existing runner volume", () => {
    const args = sysboxRegistryConfigArgs("runner-data", REGISTRY_CACHE_IMAGE);
    expect(args).toContain("type=volume,source=runner-data,target=/data");
    const encoded = args.find((argument) => argument.startsWith("DIM_REGISTRY_DAEMON_CONFIG="));
    expect(encoded).toBeDefined();
    if (encoded === undefined) throw new TypeError("expected an encoded registry daemon configuration");
    const config = JSON.parse(Buffer.from(encoded.slice(encoded.indexOf("=") + 1), "base64").toString("utf8"));
    expect(config).toEqual({
      "registry-mirrors": ["http://dim-registry-cache:5000"],
      "insecure-registries": ["dim-registry-cache:5000"]
    });
  });
});
