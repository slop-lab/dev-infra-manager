import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { COMMIT } from "./workspaceLifecycleSnapshotFixture.js";
import { nativeWorkspaceFixture } from "./nativeLifecycleFixture.js";

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

it("rejects obsolete repository catalogs in native state", async () => {
  // Given
  await writeFile(state.workspacePath(record.name), JSON.stringify({
    ...record,
    repositorySnapshot: { root: { commit: COMMIT } }
  }));

  // When / Then
  await expect(state.readWorkspace(record.name)).rejects.toThrow(/obsolete repository catalog/);
});

  it("rejects a native record with a noncanonical data path", async () => {
  // Given
  await writeFile(state.workspacePath(record.name), JSON.stringify({
    ...record,
    workspaceDataPath: "/workspace"
  }));

  // When / Then
    await expect(state.readWorkspace(record.name)).rejects.toThrow(/workspace data path/);
  });

  it("accepts native state without a persisted protected-root path", async () => {
    // Given
    await writeFile(state.workspacePath(record.name), JSON.stringify({
      ...record
    }));

    // When / Then
    await expect(state.readWorkspace(record.name)).resolves.not.toHaveProperty("rootSnapshotPath");
  });

  it("rejects native state that persists a protected-root path", async () => {
    // Given
    await writeFile(state.workspacePath(record.name), JSON.stringify({
      ...record,
      rootSnapshotPath: join(root, "other-root")
    }));

    // When / Then
    await expect(state.readWorkspace(record.name)).rejects.toThrow(/obsolete protected-root path/);
  });
});
