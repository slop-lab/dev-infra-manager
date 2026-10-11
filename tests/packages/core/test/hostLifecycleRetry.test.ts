import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHost } from "../../../../core/packages/core/src/hostLifecycle.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import * as workspaceLifecycle from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { StatefulContainerRunner } from "./ciRunnerContainerRunner.js";
import { hostLifecycleOptions, hostRecord, workspaceRecord } from "./hostLifecycleFixture.js";

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => {})
}));

vi.mock("../../../../core/packages/core/src/registryCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/registryCache.js")>(),
  ensureRegistryCache: vi.fn(async () => {})
}));

vi.mock("../../../../core/packages/core/src/aptCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/aptCache.js")>(),
  ensureAptCache: vi.fn(async () => {})
}));

describe("host lifecycle repeated failure recovery", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-host-retry-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("retains every recovery target across repeated fail-closed attempts", async () => {
    const state = new LifecycleState(root);
    const expectedLists = {
      resumeManagedContainers: ["missing-managed"],
      resumeWorkspaces: ["later-workspace"],
      restartCiRunners: [{ project: "missing-project", name: "missing-runner" }]
    };
    await state.writeHostLifecycle({ ...hostRecord("stopped", expectedLists), ...expectedLists });
    let workspace = workspaceRecord("later-workspace", "error");
    await state.claimWorkspace(workspace);
    vi.spyOn(workspaceLifecycle, "showWorkspace").mockImplementation(async () => workspace);
    vi.spyOn(workspaceLifecycle, "setupWorkspace").mockImplementation(async () => {
      workspace = workspaceRecord("later-workspace", "ready");
      return workspace;
    });
    const runner = new StatefulContainerRunner();

    await expect(startHost(runner, hostLifecycleOptions(root))).rejects.toThrow(/missing-managed/);
    expect(workspace.phase).toBe("error");
    await expect(state.readHostLifecycle()).resolves.toMatchObject({ phase: "error", ...expectedLists });

    await expect(startHost(runner, hostLifecycleOptions(root))).rejects.toThrow(/missing-managed/);
    await expect(state.readHostLifecycle()).resolves.toMatchObject({ phase: "error", ...expectedLists });
    expect(workspaceLifecycle.showWorkspace).not.toHaveBeenCalled();
    expect(workspaceLifecycle.setupWorkspace).not.toHaveBeenCalled();
    expect(runner.calls.filter((call) => call[1] === "container" && call[2] === "inspect")).toHaveLength(2);
  });
});
