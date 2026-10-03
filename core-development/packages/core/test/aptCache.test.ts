import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APT_CACHE_CONTAINER,
  APT_CACHE_ENDPOINT,
  APT_CACHE_VOLUME,
  aptCacheContainerArgs,
  ensureAptCache
} from "../../../../core/packages/core/src/aptCache.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { hostMirrorInspection } from "../../../../core/packages/core/src/hostMirrorOwnership.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { hostLifecycleOptions, TEST_HOST_MIRROR_OWNERSHIP } from "./hostLifecycleFixture.js";

const APT_IMAGE = `registry.example/apt-cache@sha256:${"b".repeat(64)}`;

class AptCacheRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    const missing = args[0] === "volume"
      ? `Error response from daemon: get ${APT_CACHE_VOLUME}: no such volume`
      : `Error response from daemon: No such container: ${APT_CACHE_CONTAINER}`;
    return args[1] === "inspect"
      ? { command, args, stdout: "", stderr: missing, exitCode: 1 }
      : { command, args, stdout: "", stderr: "", exitCode: 0 };
  }

  async runStreaming(): Promise<number> { return 0; }
}

describe("APT cache", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "dim-apt-cache-test-"));
    await new LifecycleState(stateRoot).writeHostMirrorOwnership(TEST_HOST_MIRROR_OWNERSHIP);
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("runs the provider-selected immutable image without publishing a host port", () => {
    // Given / When
    const args = aptCacheContainerArgs(APT_IMAGE, TEST_HOST_MIRROR_OWNERSHIP);

    // Then
    expect(APT_CACHE_ENDPOINT).toBe("dim-apt-cache:3142");
    expect(args).toEqual(expect.arrayContaining([
      "--name", APT_CACHE_CONTAINER,
      "--network-alias", APT_CACHE_CONTAINER,
      "--mount", `type=volume,source=${APT_CACHE_VOLUME},target=/var/cache/apt-cacher-ng`,
      APT_IMAGE
    ]));
    expect(args).not.toContain("--publish");
  });

  it("reconciles only the host provider image", async () => {
    // Given
    const runner = new AptCacheRunner();
    const options = {
      ...hostLifecycleOptions(stateRoot),
      hostMirrorProvider: {
        dockerImage: `registry.example/docker-cache@sha256:${"a".repeat(64)}`,
        aptImage: APT_IMAGE
      }
    };

    // When
    await ensureAptCache(runner, options);

    // Then
    expect(runner.calls).toContainEqual(["docker", ...aptCacheContainerArgs(APT_IMAGE, TEST_HOST_MIRROR_OWNERSHIP)]);
  });

  it("fails before Docker mutation when no host mirror provider is enabled", async () => {
    // Given
    const runner = new AptCacheRunner();
    const { hostMirrorProvider: _provider, ...options } = hostLifecycleOptions(stateRoot);

    // When
    const ensure = ensureAptCache(runner, options);

    // Then
    await expect(ensure).rejects.toThrow(/requires one enabled host mirror provider/);
    expect(runner.calls).toEqual([]);
  });

  it("does not replace a same-name cache with only the generic managed label", async () => {
    // Given
    const calls: string[][] = [];
    const runner: StreamingCommandRunner = {
      async run(command, args) {
        calls.push([command, ...args]);
        const stdout = args[0] === "container"
          ? `foreign-id|true||||true|registry.example/old@sha256:${"c".repeat(64)}\n`
          : `${hostMirrorInspection("apt-cache-data", TEST_HOST_MIRROR_OWNERSHIP)}\n`;
        return { command, args, stdout, stderr: "", exitCode: 0 };
      },
      async runStreaming() { return 0; }
    };
    const options = {
      ...hostLifecycleOptions(stateRoot),
      hostMirrorProvider: { dockerImage: APT_IMAGE, aptImage: APT_IMAGE }
    };

    // When
    const reconciliation = ensureAptCache(runner, options);

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
          ? `apt-id|${hostMirrorInspection("apt-cache", TEST_HOST_MIRROR_OWNERSHIP)}|true|registry.example/old@sha256:${"c".repeat(64)}|bridge|bind:foreign:/var/cache/apt-cacher-ng:true|[]|no\n`
          : `${hostMirrorInspection("apt-cache-data", TEST_HOST_MIRROR_OWNERSHIP)}\n`;
        return { command, args, stdout, stderr: "", exitCode: 0 };
      },
      async runStreaming() { return 0; }
    };
    const options = {
      ...hostLifecycleOptions(stateRoot),
      hostMirrorProvider: { dockerImage: APT_IMAGE, aptImage: APT_IMAGE }
    };

    // When
    const reconciliation = ensureAptCache(runner, options);

    // Then
    await expect(reconciliation).rejects.toThrow(/runtime configuration/);
    expect(calls.some((call) => call.includes("rm"))).toBe(false);
  });
});
