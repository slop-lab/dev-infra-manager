import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";

describe("registry cache lifecycle lock", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "dim-registry-cache-lock-"));
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("uses one stable host-global identity distinct from the host lifecycle lock", async () => {
    // Given
    const state = new LifecycleState(stateRoot);
    const releaseHost = await state.acquireHostLifecycleLock();

    // When
    const releaseRegistryCache = await state.acquireRegistryCacheLock();

    // Then
    await expect(readFile(join(stateRoot, "locks", "host-lifecycle.lock"), "utf8")).resolves.toContain(`"pid":${process.pid}`);
    await expect(readFile(join(stateRoot, "locks", "registry-cache.lock"), "utf8")).resolves.toContain(`"pid":${process.pid}`);
    await releaseRegistryCache();
    await releaseHost();
  });
});
