import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import {
  ensureRegistryCache
} from "../../../../core/packages/core/src/registryCache.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { claimTestGiteaService, ownedGiteaResourceInspect } from "./giteaServiceFixture.js";
import { hostLifecycleOptions, registryCacheInspect, TEST_HOST_MIRROR_OWNERSHIP, TEST_HOST_MIRROR_PROVIDER } from "./hostLifecycleFixture.js";
import { hostMirrorInspection } from "../../../../core/packages/core/src/hostMirrorOwnership.js";

const REGISTRY_CACHE_IMAGE = TEST_HOST_MIRROR_PROVIDER.dockerImage;

class ReadyRegistryCacheRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    const stdout = args[0] === "network"
      ? `${ownedGiteaResourceInspect("network")}\n`
      : args[0] === "volume"
      ? `${hostMirrorInspection("registry-cache-data", TEST_HOST_MIRROR_OWNERSHIP)}\n`
        : registryCacheInspect(REGISTRY_CACHE_IMAGE);
    return { command, args, stdout, stderr: "", exitCode: 0 };
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

describe("registry cache release failures", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "dim-registry-cache-release-"));
    await claimTestGiteaService(stateRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("releases the managed Gitea lease when registry lock acquisition fails", async () => {
    // Given
    const acquisitionError = new Error("injected registry cache acquisition failure");
    vi.spyOn(LifecycleState.prototype, "acquireRegistryCacheLock")
      .mockRejectedValueOnce(acquisitionError);
    const runner = new ReadyRegistryCacheRunner();
    const options = hostLifecycleOptions(stateRoot);

    // When
    const firstReconciliation = ensureRegistryCache(runner, options);

    // Then
    await expect(firstReconciliation).rejects.toBe(acquisitionError);
    await expect(readFile(join(stateRoot, "locks", "gitea-service.lock"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(ensureRegistryCache(runner, options)).resolves.toBeUndefined();
    expect(runner.calls).toHaveLength(3);
  });

  it("releases the managed Gitea lease when registry lock release fails", async () => {
    // Given
    const acquireRegistryCacheLock = LifecycleState.prototype.acquireRegistryCacheLock;
    let failRelease = true;
    vi.spyOn(LifecycleState.prototype, "acquireRegistryCacheLock").mockImplementation(async function (
      this: LifecycleState
    ) {
      const release = await acquireRegistryCacheLock.call(this);
      return async () => {
        await release();
        if (failRelease) {
          failRelease = false;
          throw new Error("injected registry cache release failure");
        }
      };
    });
    const runner = new ReadyRegistryCacheRunner();
    const options = hostLifecycleOptions(stateRoot);

    // When
    const firstReconciliation = ensureRegistryCache(runner, options);

    // Then
    await expect(firstReconciliation).rejects.toThrow("injected registry cache release failure");
    await expect(readFile(join(stateRoot, "locks", "gitea-service.lock"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(ensureRegistryCache(runner, options)).resolves.toBeUndefined();
    expect(runner.calls).toHaveLength(6);
  });
});
