import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { workspaceRecord } from "./hostLifecycleFixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace lifecycle claims", () => {
  it("claims a native workspace name atomically and serializes lifecycle locks", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-lifecycle-claims-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const workspace = workspaceRecord("work-1", "creating");

    await state.claimWorkspace(workspace);
    await expect(state.claimWorkspace(workspace)).rejects.toThrow(/already exists/);

    const release = await state.acquireWorkspaceLock(workspace.name);
    let acquired = false;
    const waiting = state.acquireWorkspaceLock(workspace.name).then(async (releaseWaiting) => {
      acquired = true;
      await releaseWaiting();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acquired).toBe(false);
    await release();
    await waiting;
    expect(acquired).toBe(true);

    const releaseSetup = await state.acquireWorkspaceSetupLock(workspace.name);
    const releaseReconciliation = await state.acquireWorkspaceLock(workspace.name);
    let setupAcquired = false;
    const setupWaiting = state.acquireWorkspaceSetupLock(workspace.name).then(async (releaseWaiting) => {
      setupAcquired = true;
      await releaseWaiting();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setupAcquired).toBe(false);
    await releaseReconciliation();
    expect(setupAcquired).toBe(false);
    await releaseSetup();
    await setupWaiting;
    expect(setupAcquired).toBe(true);
  });
});
