import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptions } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState, validateLifecycleName } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, RunOptions, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import {
  detectWorkspaceKvm,
  projectRuntimeManifest,
  resolveWorkspaceCapabilities,
  resolveWorkspaceKvm,
  restartWorkspace,
  updateWorkspaceResources,
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

it("auto-detects optional KVM for Sysbox workspaces", async () => {
    await expect(detectWorkspaceKvm("sysbox", async () => {})).resolves.toBe(true);
    await expect(detectWorkspaceKvm("sysbox", async () => {
      throw new Error("missing");
    })).resolves.toBe(false);
  });

it("honors explicit workspace KVM policy", async () => {
    await expect(resolveWorkspaceKvm("sysbox", undefined, async () => {})).resolves.toBe(true);
    await expect(resolveWorkspaceKvm("sysbox", false, async () => {})).resolves.toBe(false);
    await expect(resolveWorkspaceKvm("sysbox", true, async () => {})).resolves.toBe(true);
    await expect(resolveWorkspaceKvm("sysbox", true, async () => {
      throw new Error("missing");
    })).rejects.toThrow(/KVM was requested but is unavailable/);
  });

it("selects persistent workspace runtime backends", () => {
    const options = lifecycleOptions({ DIM_STATE_ROOT: root, DIM_CONFIG_PATH: join(root, "dim.json") });
  expect(workspaceRuntimePlan("sysbox", options)).toMatchObject({
      dockerRuntime: "runc",
      image: "dev-infra-project-workspace:0.9.0",
      privileged: true,
      engine: "docker",
      env: { DIM_DOCKERD_FLAGS: "--feature containerd-snapshotter=false" }
    });
  });

  it("preserves an explicit workspace image override", () => {
    const options = lifecycleOptions({
      DIM_STATE_ROOT: root,
      DIM_CONFIG_PATH: join(root, "dim.json"),
      DIM_WORKSPACE_IMAGE: "registry.example/workspace@sha256:explicit"
    });

    expect(workspaceRuntimePlan("sysbox", options).image).toBe(
      "registry.example/workspace@sha256:explicit"
    );
  });
});
