import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceStore } from "../../../packages/host/core/src/workspace/store.js";
import { prepareWorkspaceReadiness } from "../../../packages/host/core/src/application/workspace-readiness.js";
import { workspaceRecord } from "../../support/workspaceFixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("retains a running workspace and publishes integration failure until preparation recovers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-workspace-readiness-")); roots.push(root);
  const store = new WorkspaceStore(root), workspace = workspaceRecord(); await store.write(workspace);
  await expect(prepareWorkspaceReadiness(workspace, store, async () => { throw new Error("recover the existing gateway"); }))
    .rejects.toThrow("runtime remains running; integration preparation failed");
  expect(await store.read(workspace.name)).toMatchObject({ id: workspace.id, phase: "running", error: "Integration preparation failed: recover the existing gateway" });
  await prepareWorkspaceReadiness(workspace, store, async () => {});
  expect(await store.read(workspace.name)).not.toHaveProperty("error");
});

it.each(["stopped", "replaced", "updated"] as const)("does not overwrite a %s workspace after delayed preparation failure", async (transition) => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-workspace-readiness-race-")); roots.push(root);
  const store = new WorkspaceStore(root), workspace = workspaceRecord(); await store.write(workspace);
  const changed = transition === "stopped" ? { ...workspace, phase: "stopped" as const }
    : transition === "replaced" ? { ...workspace, id: "33333333-3333-4333-8333-333333333333" }
    : { ...workspace, updatedAt: new Date(Date.parse(workspace.updatedAt) + 1_000).toISOString() };
  await expect(prepareWorkspaceReadiness(workspace, store, async () => {
    await store.write(changed); throw new Error("late preparation");
  })).rejects.toThrow("late preparation");
  expect(await store.read(workspace.name)).toMatchObject({ id: changed.id, phase: changed.phase });
  expect(await store.read(workspace.name)).not.toHaveProperty("error");
});
