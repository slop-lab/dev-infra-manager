import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ciRunner from "../../../../core/packages/core/src/ciRunner.js";
import * as gitea from "../../../../core/packages/core/src/gitea.js";
import { hostLifecycleStatus, startHost } from "../../../../core/packages/core/src/hostLifecycle.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import * as registryCache from "../../../../core/packages/core/src/registryCache.js";
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

const WORKSPACE_CASES = [
  { phase: "ready", dispatch: "none" },
  { phase: "stopped", dispatch: "start" },
  { phase: "setting-up", dispatch: "setup" },
  { phase: "setup-error", dispatch: "setup" },
  { phase: "error", dispatch: "setup" },
  { phase: "creating", dispatch: "reject" }
] as const;

describe("host lifecycle recovery matrix", () => {
  let root: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), "dim-host-recovery-matrix-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  describe.each(["stopped", "starting", "stopping", "error"] as const)(
    "from %s host entry",
    (entryPhase) => {
      it.each(WORKSPACE_CASES)(
        "maps a $phase workspace to $dispatch",
        async ({ phase, dispatch }) => {
          // Given
          const state = new LifecycleState(root);
          await state.writeHostLifecycle(hostRecord(entryPhase, {
            resumeWorkspaces: ["workspace"],
            restartCiRunners: []
          }));
          vi.spyOn(workspaceLifecycle, "showWorkspace").mockResolvedValue(workspaceRecord("workspace", phase));
          vi.spyOn(workspaceLifecycle, "startWorkspace").mockResolvedValue(workspaceRecord("workspace", "ready"));
          vi.spyOn(workspaceLifecycle, "setupWorkspace").mockResolvedValue(workspaceRecord("workspace", "ready"));

          // When
          const recovery = startHost(new StatefulContainerRunner(), hostLifecycleOptions(root));

          // Then
          if (dispatch === "reject") await expect(recovery).rejects.toThrow(/still creating/);
          else await expect(recovery).resolves.toMatchObject({ phase: "ready", resumeWorkspaces: [] });
          expect(workspaceLifecycle.startWorkspace).toHaveBeenCalledTimes(dispatch === "start" ? 1 : 0);
          expect(workspaceLifecycle.setupWorkspace).toHaveBeenCalledTimes(dispatch === "setup" ? 1 : 0);
        }
      );
    }
  );

  it("reconciles managed Git without replaying recovery when host state is ready", async () => {
    // Given
    const state = new LifecycleState(root);
    const ready = {
      ...hostRecord("ready", {
        resumeWorkspaces: ["workspace"],
        restartCiRunners: [{ project: "project", name: "runner" }]
      }),
      resumeManagedContainers: ["managed"]
    };
    await state.writeHostLifecycle(ready);
    const runner = new StatefulContainerRunner();
    vi.spyOn(workspaceLifecycle, "showWorkspace");
    vi.spyOn(ciRunner, "startCiRunner");
    vi.spyOn(ciRunner, "stopCiRunner");

    // When
    const result = await startHost(runner, hostLifecycleOptions(root));

    // Then
    expect(result).toEqual(ready);
    expect(runner.calls).toEqual([]);
    expect(gitea.ensureGitea).toHaveBeenCalledOnce();
    expect(registryCache.ensureRegistryCache).not.toHaveBeenCalled();
    expect(workspaceLifecycle.showWorkspace).not.toHaveBeenCalled();
    expect(ciRunner.startCiRunner).not.toHaveBeenCalled();
    expect(ciRunner.stopCiRunner).not.toHaveBeenCalled();
  });

  it("rejects invalid managed Git before publishing ready when host state is absent", async () => {
    // Given
    const runner = new StatefulContainerRunner();
    vi.mocked(gitea.ensureGitea).mockRejectedValueOnce(new Error("managed Git endpoint is invalid"));
    vi.spyOn(workspaceLifecycle, "showWorkspace");
    vi.spyOn(ciRunner, "startCiRunner");
    vi.spyOn(ciRunner, "stopCiRunner");

    // When
    const recovery = startHost(runner, hostLifecycleOptions(root));

    // Then
    await expect(recovery).rejects.toThrow("managed Git endpoint is invalid");
    expect(gitea.ensureGitea).toHaveBeenCalledOnce();
    expect(registryCache.ensureRegistryCache).not.toHaveBeenCalled();
    expect(workspaceLifecycle.showWorkspace).not.toHaveBeenCalled();
    expect(ciRunner.startCiRunner).not.toHaveBeenCalled();
    expect(ciRunner.stopCiRunner).not.toHaveBeenCalled();
    expect(runner.calls).toEqual([]);
  });

  it.each(["absent", "ready"] as const)(
    "persists an error without stale recovery intent when managed Git reconciliation fails from %s state",
    async (entryState) => {
      // Given
      const state = new LifecycleState(root);
      const options = hostLifecycleOptions(root);
      if (entryState === "ready") {
        await state.writeHostLifecycle({
          ...hostRecord("ready", {
            resumeWorkspaces: ["workspace"],
            restartCiRunners: [{ project: "project", name: "runner" }]
          }),
          resumeManagedContainers: ["managed"]
        });
      }
      await expect(hostLifecycleStatus(options)).resolves.toMatchObject({ phase: "ready" });
      vi.mocked(gitea.ensureGitea).mockRejectedValueOnce(new Error("managed Git reconciliation failed"));

      // When
      const recovery = startHost(new StatefulContainerRunner(), options);

      // Then
      await expect(recovery).rejects.toThrow("managed Git reconciliation failed");
      await expect(hostLifecycleStatus(options)).resolves.toMatchObject({
        phase: "error",
        error: "managed Git reconciliation failed",
        resumeWorkspaces: [],
        restartCiRunners: [],
        resumeManagedContainers: []
      });
    }
  );

  it("publishes ready after reconciling managed Git when host state is absent", async () => {
    // Given
    const runner = new StatefulContainerRunner();

    // When
    const result = await startHost(runner, hostLifecycleOptions(root));

    // Then
    expect(result.phase).toBe("ready");
    expect(gitea.ensureGitea).toHaveBeenCalledOnce();
  });

  it("preserves external Git behavior when host state is absent", async () => {
    // Given
    const runner = new StatefulContainerRunner();
    const options = {
      ...hostLifecycleOptions(root),
      giteaConnection: { kind: "external" as const, file: "/run/secrets/gitea.json" }
    };

    // When
    const result = await startHost(runner, options);

    // Then
    expect(result.phase).toBe("ready");
    expect(gitea.ensureGitea).not.toHaveBeenCalled();
  });

  it("rejects malformed schema 2 state without mutation or dispatch", async () => {
    // Given
    const state = new LifecycleState(root);
    const rawState = `${JSON.stringify({
      ...hostRecord("starting"),
      unexpected: "field"
    }, null, 2)}\n`;
    await writeFile(state.hostLifecyclePath(), rawState);
    const runner = new StatefulContainerRunner();
    vi.spyOn(workspaceLifecycle, "showWorkspace");
    vi.spyOn(ciRunner, "startCiRunner");
    vi.spyOn(ciRunner, "stopCiRunner");

    // When
    const recovery = startHost(runner, hostLifecycleOptions(root));

    // Then
    await expect(recovery).rejects.toThrow(/unknown field 'unexpected'/);
    await expect(readFile(state.hostLifecyclePath(), "utf8")).resolves.toBe(rawState);
    expect(runner.calls).toEqual([]);
    expect(gitea.ensureGitea).not.toHaveBeenCalled();
    expect(registryCache.ensureRegistryCache).not.toHaveBeenCalled();
    expect(workspaceLifecycle.showWorkspace).not.toHaveBeenCalled();
    expect(ciRunner.startCiRunner).not.toHaveBeenCalled();
    expect(ciRunner.stopCiRunner).not.toHaveBeenCalled();
  });
});
