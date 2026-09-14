import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTROL_NETWORK,
  ensureRegistryCache,
  REGISTRY_CACHE_CONTAINER,
  REGISTRY_CACHE_ENDPOINT,
  REGISTRY_CACHE_IMAGE,
  REGISTRY_CACHE_VOLUME,
  registryCacheContainerArgs,
  sysboxRegistryConfigArgs
} from "../../../../core/packages/core/src/registryCache.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

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
      ? `true|true|${REGISTRY_CACHE_IMAGE}\n`
      : "true\n";
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
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("replaces the cache without exposing its ephemeral network address", async () => {
    // Given
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args): Promise<CommandResult> {
        calls.push([command, ...args]);
        const output = args[0] === "network" || args[0] === "volume"
          ? "true\n"
          : args.includes("{{index .Config.Labels \"dim.managed\"}}|{{.State.Running}}|{{.Config.Image}}")
            ? "true|true|registry@sha256:obsolete\n"
            : args.some((argument) => argument.includes(".NetworkSettings.Networks"))
              ? "172.18.0.9\n"
              : "";
        return { command, args, stdout: output, stderr: "", exitCode: 0 };
      },
      async runStreaming(): Promise<number> { return 0; }
    };

    // When
    const connection = await ensureRegistryCache(runner, stateRoot);

    // Then
    expect(connection).toBeUndefined();
    expect(calls.some((call) => call.some((argument) => argument.includes(".NetworkSettings.Networks")))).toBe(false);
    expect(calls).toContainEqual(["docker", "container", "rm", "--force", REGISTRY_CACHE_CONTAINER]);
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
    await ensureRegistryCache(runner, stateRoot);

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
    const ensure = ensureRegistryCache(runner, stateRoot);

    // Then
    await expect(ensure).rejects.toThrow(/inspect/);
    expect(runner.calls.every((call) => call[2] === "inspect")).toBe(true);
  });

  it("runs an internal pinned Docker Hub pull-through cache", () => {
    const args = registryCacheContainerArgs();
    expect(REGISTRY_CACHE_ENDPOINT).toBe("dim-registry-cache:5000");
    expect(args).toEqual(expect.arrayContaining([
      "--name", REGISTRY_CACHE_CONTAINER,
      "--network", CONTROL_NETWORK,
      "--mount", `type=volume,source=${REGISTRY_CACHE_VOLUME},target=/var/lib/registry`,
      "--env", "REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io",
      "--env", "REGISTRY_STORAGE_DELETE_ENABLED=true",
      REGISTRY_CACHE_IMAGE
    ]));
    expect(args).not.toContain("--publish");
    expect(args).not.toContain("--add-host=registry-1.docker.io:127.0.0.1");
    expect(args).not.toContain("--add-host=auth.docker.io:127.0.0.1");
    expect(REGISTRY_CACHE_IMAGE).toMatch(/^registry@sha256:[0-9a-f]{64}$/);
  });

  it("writes the Sysbox daemon mirror into its existing runner volume", () => {
    const args = sysboxRegistryConfigArgs("runner-data");
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
