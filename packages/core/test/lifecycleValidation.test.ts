import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptions } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  alignWorkspaceRoot,
  detectWorkspaceKvm,
  projectRuntimeManifest,
  resolveWorkspaceCapabilities,
  resolveRepositorySnapshot,
  resolveWorkspaceKvm,
  restartWorkspace,
  updateWorkspaceResources,
  validateRepositoryRefOverrides,
  validateWorkspaceProfiles,
  validateWorkspaceResources,
  waitForInnerDocker,
  workspaceContainerArgs
} from "../../../../core/packages/core/src/workspaceLifecycle.js";
import { workspaceRuntimePlan } from "../../../../core/packages/core/src/runtimeBackends.js";
import { rootRepositorySnapshot } from "./lifecycleFixture.js";

describe("project and workspace lifecycle", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-lifecycle-"));
    await writeFile(join(root, "dim.json"), JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

it("validates non-root candidate repository ref overrides", () => {
    const project = {
      schemaVersion: 4 as const,
      id: "project-id",
      name: "project",
      gitNamespace: "dim-project",
      giteaOrganizationId: 41,
      phase: "ready" as const,
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      repositories: ["root", "core"].map((alias) => ({
        alias,
        providerRepoId: `dim-project/${alias}`,
        owner: "dim-project",
        hostUrl: `http://host/${alias}.git`,
        workspaceUrl: `http://workspace/${alias}.git`,
        phase: "ready" as const,
        connections: [],
        protectedPatterns: [],
        protectionPhase: "applied" as const,
        createdAt: "now",
        updatedAt: "now"
      })),
      createdAt: "now",
      updatedAt: "now"
    };
    expect(validateRepositoryRefOverrides(["core=refs/pull/7/head"], project)).toEqual({
      core: "refs/pull/7/head"
    });
    expect(() => validateRepositoryRefOverrides(["root=next"], project)).toThrow(/root repository/);
    expect(() => validateRepositoryRefOverrides(["missing=next"], project)).toThrow(/no repository/);
    expect(() => validateRepositoryRefOverrides(["core=one", "core=two"], project)).toThrow(/duplicated/);
  });

it("validates names and container-only option overrides", () => {
    expect(validateLifecycleName("repo-1", "repo")).toBe("repo-1");
    expect(() => validateLifecycleName("../repo", "repo")).toThrow(/repo name/);
    expect(() => lifecycleOptions({ DIM_CONFIG_PATH: join(root, "missing.json") })).toThrow(
      /workspace backend is not configured/
    );
    const options = lifecycleOptions({
      DIM_STATE_ROOT: root,
      DIM_CONFIG_PATH: join(root, "dim.json"),
      DIM_GITEA_PORT: "4300",
      DIM_WORKSPACE_MEMORY: "2g"
    });
    expect(options.giteaPort).toBe(4300);
    expect(options.memory).toBe("2g");
    expect(options.giteaImage).toBe("gitea/gitea:1.27.0");
    expect(options.defaultWorkspaceBackend).toBe("sysbox");
    expect(validateWorkspaceProfiles(["development", "secrets"])).toEqual(["development", "secrets"]);
    expect(() => validateWorkspaceProfiles(["development", "development"])).toThrow(/duplicated/);
    expect(() => validateWorkspaceProfiles(["bad,profile"])).toThrow(/workspace profile/);
    expect(() => validateWorkspaceResources({
      cpuCount: "0",
      memory: "4g",
      pidsLimit: "2048"
    })).toThrow(/CPU limit/);
    expect(() => validateWorkspaceResources({
      cpuCount: "2",
      memory: "unlimited",
      pidsLimit: "2048"
    })).toThrow(/memory limit/);
  });
});
