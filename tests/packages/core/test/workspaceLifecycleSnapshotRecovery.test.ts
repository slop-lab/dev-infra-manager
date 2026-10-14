import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { setupWorkspace } from "../../../../core/packages/core/src/workspaceLifecycle.js";

import { seedTestHostMirrorOwnership, TEST_HOST_MIRROR_PROVIDER } from "./hostLifecycleFixture.js";
import { COMMIT, LifecycleRunner } from "./workspaceLifecycleSnapshotFixture.js";
import { nativeWorkspaceFixture } from "./nativeLifecycleFixture.js";
import { workspaceContainerInspect } from "./workspaceOwnershipFixture.js";

describe("immutable workspace lifecycle dispatch", () => {
  let root = "";
  let state: LifecycleState;
  let record: WorkspaceRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-lifecycle-snapshot-"));
    state = new LifecycleState(root);
    record = nativeWorkspaceFixture({ rootCommit: COMMIT, environment: "custom", profiles: ["development"] });
  await mkdir(join(root, "assets", "native-project-roots", record.projectId, record.rootCommit), { recursive: true });
    await state.claimWorkspace(record);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

it("publishes a setup-error manifest solely from the recorded root contract", async () => {
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, {
    rootSnapshotPath: join(root, "assets", "native-project-roots", record.projectId, record.rootCommit)
    });
    const failed = { ...record, phase: "setup-error" } as const;
    await state.writeWorkspace(failed);

    await setupWorkspace(runner, options(root), record.name);

    expect(runner.runCalls.some((call) => call.includes("ls-remote"))).toBe(false);
    expect(runner.publishedManifests[0]).toMatchObject({
      schemaVersion: 3,
      root: { ref: record.rootRef, commit: record.rootCommit, path: "/run/dim/project-root" },
      data: { path: record.workspaceDataPath }
    });
    expect(runner.publishedManifests[0]).not.toHaveProperty("repositories");
  });

  it("recovers a failed initial manifest publication without Git mutation", async () => {
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, {
    rootSnapshotPath: join(root, "assets", "native-project-roots", record.projectId, record.rootCommit)
    });
    const failed = { ...record, phase: "error" } as const;
    await state.writeWorkspace(failed);

    await setupWorkspace(runner, options(root), record.name);

    expect(runner.runCalls.some((call) => call.includes("ls-remote"))).toBe(false);
    expect(runner.publishedManifests[0]).not.toHaveProperty("repositories");
  });

  it("rejects a same-name foreign replacement before recovery changes selected-root or Git state", async () => {
    const interrupted = { ...record, phase: "setup-error" as const };
    await state.writeWorkspace(interrupted);
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, {
    rootSnapshotPath: join(root, "assets", "native-project-roots", record.projectId, record.rootCommit)
    })
      .replace("|project-id|", "|foreign-project-id|");

    await expect(setupWorkspace(
      runner,
      options(root),
      record.name
    )).rejects.toThrow(/conflicts with DIM ownership/);
    await expect(state.readWorkspace(record.name)).resolves.toMatchObject({
      phase: "setup-error",
      rootCommit: interrupted.rootCommit
    });
    expect(runner.runCalls.some((call) => call.includes("git"))).toBe(false);
  });

  it("reconciles recovery when the owned container mounts a different immutable root", async () => {
    // Given
    const interrupted = { ...record, phase: "setup-error" as const };
    await state.writeWorkspace(interrupted);
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, { rootSnapshotPath: join(root, "old-root") });

    // When
    const recovered = await setupWorkspace(
      runner,
      options(root),
      record.name
    );

    // Then
    expect(recovered).toMatchObject({ phase: "ready", rootCommit: record.rootCommit });
    expect(recovered).not.toHaveProperty("rootSnapshotPath");
    expect(runner.runCalls).toContainEqual(["docker", "container", "rm", "--force", "workspace-container-id"]);
    expect(runner.publishedManifests).toHaveLength(1);
    expect(runner.streamingCalls).toHaveLength(1);
  });

  it("recovers the recorded native protected ref without resolving mutable refs", async () => {
    const runner = new LifecycleRunner();
    runner.containerInspect = workspaceContainerInspect(record, {
    rootSnapshotPath: join(root, "assets", "native-project-roots", record.projectId, record.rootCommit)
    });
    await state.writeWorkspace({ ...record, phase: "setup-error" });

    await setupWorkspace(runner, options(root), record.name);

    expect(runner.runCalls.some((call) => call.includes("ls-remote"))).toBe(false);
    expect(runner.publishedManifests[0]?.root).toMatchObject({ ref: record.rootRef, commit: record.rootCommit });
  });
});

function options(stateRoot: string) {
  seedTestHostMirrorOwnership(stateRoot);
  return {
    ...lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: stateRoot,
      DIM_NATIVE_CONTROL_PLANE_CONNECTION_FILE: join(stateRoot, "control.json") }),
    hostMirrorProvider: TEST_HOST_MIRROR_PROVIDER
  };
}
