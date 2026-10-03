import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureRegistryCache
} from "../../../../core/packages/core/src/registryCache.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { hostMirrorInspection } from "../../../../core/packages/core/src/hostMirrorOwnership.js";
import { registryCacheInspect, TEST_HOST_MIRROR_OWNERSHIP } from "./hostLifecycleFixture.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";

const REGISTRY_CACHE_IMAGE = `registry.example/docker-cache@sha256:${"a".repeat(64)}`;

class Barrier {
  readonly wait: Promise<void>;
  private openBarrier: () => void = () => undefined;

  constructor() {
    this.wait = new Promise((resolve) => {
      this.openBarrier = resolve;
    });
  }

  open(): void {
    this.openBarrier();
  }
}

type CacheState = {
  network: boolean;
  volume: boolean;
  containerImage: string | undefined;
};

class ConcurrentRegistryRunner implements StreamingCommandRunner {
  readonly firstMutationEntered = new Barrier();
  readonly releaseFirstMutation = new Barrier();
  readonly mutations: string[] = [];
  failFirstMutation = false;
  private mutationAttempts = 0;

  constructor(private readonly state: CacheState) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    if (args[1] === "inspect") return this.inspect(command, args);

    this.mutationAttempts += 1;
    if (this.mutationAttempts === 1) {
      this.firstMutationEntered.open();
      await this.releaseFirstMutation.wait;
      if (this.failFirstMutation) return result(command, args, { exitCode: 1, stderr: "injected mutation failure" });
    }
    return this.mutate(command, args);
  }

  async runStreaming(): Promise<number> {
    return 0;
  }

  private inspect(command: string, args: string[]): CommandResult {
    switch (args[0]) {
      case "network":
        return this.state.network
        ? result(command, args, { exitCode: 0, stdout: `${hostMirrorInspection("control-network", TEST_HOST_MIRROR_OWNERSHIP)}\n` })
          : result(command, args, { exitCode: 1, stderr: "Error response from daemon: network dim-control not found" });
      case "volume":
        return this.state.volume
          ? result(command, args, { exitCode: 0, stdout: `${hostMirrorInspection("registry-cache-data", TEST_HOST_MIRROR_OWNERSHIP)}\n` })
          : result(command, args, { exitCode: 1, stderr: "Error response from daemon: get dim-registry-cache-data: no such volume" });
      case "container":
        return this.state.containerImage === undefined
          ? result(command, args, { exitCode: 1, stderr: "Error response from daemon: No such container: dim-registry-cache" })
        : result(command, args, { exitCode: 0, stdout: registryCacheInspect(this.state.containerImage) });
      default:
        throw new Error(`unexpected inspect target '${args[0]}'`);
    }
  }

  private mutate(command: string, args: string[]): CommandResult {
    const operation = args.slice(0, 3).join(" ");
    if (args[0] === "network" && args[1] === "create") {
      if (this.state.network) return result(command, args, { exitCode: 1, stderr: "network already exists" });
      this.state.network = true;
    } else if (args[0] === "volume" && args[1] === "create") {
      if (this.state.volume) return result(command, args, { exitCode: 1, stderr: "volume already exists" });
      this.state.volume = true;
    } else if (args[0] === "container" && args[1] === "rm") {
      if (this.state.containerImage === undefined) return result(command, args, { exitCode: 1, stderr: "container does not exist" });
      this.state.containerImage = undefined;
    } else if (args[0] === "run") {
      if (this.state.containerImage !== undefined) return result(command, args, { exitCode: 1, stderr: "container already exists" });
      this.state.containerImage = REGISTRY_CACHE_IMAGE;
    } else {
      throw new Error(`unexpected mutation '${operation}'`);
    }
    this.mutations.push(operation);
    return result(command, args, { exitCode: 0 });
  }
}

function result(
  command: string,
  args: string[],
  output: { readonly exitCode: number; readonly stderr?: string; readonly stdout?: string }
): CommandResult {
  return {
    command,
    args,
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? "",
    exitCode: output.exitCode
  };
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("registry cache reconciliation concurrency", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "dim-registry-cache-"));
    await new LifecycleState(stateRoot).writeHostMirrorOwnership(TEST_HOST_MIRROR_OWNERSHIP);
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("mutates each resource once during simultaneous empty-state first use", async () => {
    const state: CacheState = { network: false, volume: false, containerImage: undefined };
    const runner = new ConcurrentRegistryRunner(state);
    const first = ensureRegistryCache(runner, stateRoot, REGISTRY_CACHE_IMAGE);
    await runner.firstMutationEntered.wait;

    const second = ensureRegistryCache(runner, stateRoot, REGISTRY_CACHE_IMAGE);
    await nextEventLoopTurn();
    runner.releaseFirstMutation.open();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(runner.mutations).toEqual(["network create --label", "volume create --label", "run --detach --name"]);
    expect(state).toEqual({ network: true, volume: true, containerImage: REGISTRY_CACHE_IMAGE });
  });

  it("replaces an obsolete image once during simultaneous reconciliation", async () => {
    const state: CacheState = { network: true, volume: true, containerImage: "registry@sha256:obsolete" };
    const runner = new ConcurrentRegistryRunner(state);
    const first = ensureRegistryCache(runner, stateRoot, REGISTRY_CACHE_IMAGE);
    await runner.firstMutationEntered.wait;

    const second = ensureRegistryCache(runner, stateRoot, REGISTRY_CACHE_IMAGE);
    await nextEventLoopTurn();
    runner.releaseFirstMutation.open();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(runner.mutations).toEqual(["container rm --force", "run --detach --name"]);
    expect(state.containerImage).toBe(REGISTRY_CACHE_IMAGE);
  });

  it("releases the lifecycle lock after a failed reconciliation so a waiter can reacquire", async () => {
    const state: CacheState = { network: false, volume: false, containerImage: undefined };
    const runner = new ConcurrentRegistryRunner(state);
    runner.failFirstMutation = true;
    const first = ensureRegistryCache(runner, stateRoot, REGISTRY_CACHE_IMAGE);
    await runner.firstMutationEntered.wait;
    const second = ensureRegistryCache(runner, stateRoot, REGISTRY_CACHE_IMAGE);

    runner.releaseFirstMutation.open();

    await expect(first).rejects.toThrow(/injected mutation failure/);
    await expect(second).resolves.toBeUndefined();
    expect(state).toEqual({ network: true, volume: true, containerImage: REGISTRY_CACHE_IMAGE });
  });
});
