import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/managed/src/lifecycleState.js";
import { resolveWorkspaceCapabilities } from "../../../../core/packages/managed/src/workspaceLifecycle.js";
import { workspaceRecord } from "./hostLifecycleFixture.js";

const roots: string[] = [];
const context = { workspaceId: "A".repeat(43), projectId: "project-id", projectName: "project",
  workspaceName: "work-1", runtimeBackend: "sysbox" as const };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace grants and capabilities", () => {
  it("fails closed for required capabilities and reports missing recommendations", async () => {
    await expect(resolveWorkspaceCapabilities({ required: ["missing"], recommended: [] }, context, new Map()))
      .rejects.toThrow(/required workspace capability 'missing'/);
    await expect(resolveWorkspaceCapabilities({ required: [], recommended: ["missing"] }, context, new Map()))
      .resolves.toEqual([{ name: "missing", requirement: "recommended", status: "unavailable",
        detail: "no installed provider" }]);
  });

  it("binds capability provisioning to the workspace instance", async () => {
    const provision = vi.fn(async () => ({}));
    await resolveWorkspaceCapabilities({ required: ["device"], recommended: [] }, context,
      new Map([["device", { plugin: "test", provider: { provision } }]]));
    expect(provision).toHaveBeenCalledWith(context);
  });

  it("denies capability overrides of host mirror routing", async () => {
    const resolution = resolveWorkspaceCapabilities({ required: ["mirror-override"], recommended: [] }, context,
      new Map([["mirror-override", { plugin: "test", provider: {
        provision: async () => ({ environment: { DIM_APT_CACHE_ENDPOINT: "attacker:3142" } })
      } }]]));
    await expect(resolution).rejects.toThrow(/reserved host mirror environment/);
  });

  it("authenticates audience-specific grants and invalidates captured grants after recreation", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-lifecycle-grants-"));
    roots.push(root);
    const state = new LifecycleState(root);
    const record = workspaceRecord("work-1", "ready");
    await state.claimWorkspace(record);
    const workspaceGrant = await state.ensureWorkspaceGrant(record.name);
    const agentGrant = await state.ensureAgentGrant(record.name);
    expect(await state.authenticateWorkspaceGrant(workspaceGrant)).toEqual(record);
    expect(await state.authenticateAgentGrant(agentGrant)).toEqual(record);
    expect(await state.authenticateWorkspaceGrant(agentGrant)).toBeUndefined();
    expect(await state.authenticateAgentGrant(workspaceGrant)).toBeUndefined();

    await state.removeWorkspace(record.name);
    await state.claimWorkspace({ ...record, workspaceId: "B".repeat(43) });
    expect(await state.authenticateWorkspaceGrant(workspaceGrant)).toBeUndefined();
    expect(await state.authenticateAgentGrant(agentGrant)).toBeUndefined();
    expect(await state.ensureWorkspaceGrant(record.name)).not.toBe(workspaceGrant);
    expect(await state.ensureAgentGrant(record.name)).not.toBe(agentGrant);
  });
});
