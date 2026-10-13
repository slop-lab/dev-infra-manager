import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectWorkspaceEnvironment } from "../../../../core/packages/core/src/workspaceEnvironment.js";
import { selectWorkspaceEnvironmentTransition } from "../../../../core/packages/core/src/workspaceEnvironmentTransition.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { recordSelectedRoot } from "../../../../core/packages/core/src/workspacePublication.js";

describe("workspace environment selection", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "dim-environment-"));
    roots.push(path);
    return path;
  }

  it("selects the recommended environment when .dim is absent", async () => {
    const snapshot = await root();

    await expect(selectWorkspaceEnvironment(snapshot)).resolves.toBe("recommended");
  });

  it("selects the recommended environment when .dim contains only repository policy", async () => {
    const snapshot = await root();
    await mkdir(join(snapshot, ".dim"));
    await writeFile(join(snapshot, ".dim", "repos.yml"), "schemaVersion: 1\n");

    await expect(selectWorkspaceEnvironment(snapshot)).resolves.toBe("recommended");
  });

  it("selects custom when a shipped lifecycle hook exists", async () => {
    const snapshot = await root();
    await mkdir(join(snapshot, ".dim"));
    await writeFile(join(snapshot, ".dim", "entrypoint.sh"), "#!/bin/sh\n");

    await expect(selectWorkspaceEnvironment(snapshot)).resolves.toBe("custom");
  });

  it("accepts only the exact minimal selector", async () => {
    const snapshot = await root();
    await mkdir(join(snapshot, ".dim"));
    await writeFile(join(snapshot, ".dim", "environment.yml"), "schemaVersion: 1\nenvironment: minimal\n");

    await expect(selectWorkspaceEnvironment(snapshot)).resolves.toBe("minimal");
  });

  it.each([
    "schemaVersion: 1\nenvironment: recommended\n",
    "schemaVersion: 1\nenvironment: minimal\nextra: true\n",
    "schemaVersion: 2\nenvironment: minimal\n",
    "schemaVersion: 1\nenvironment: minimal\nenvironment: minimal\n"
  ])("rejects unsafe selector YAML", async (source) => {
    const snapshot = await root();
    await mkdir(join(snapshot, ".dim"));
    await writeFile(join(snapshot, ".dim", "environment.yml"), source);

    await expect(selectWorkspaceEnvironment(snapshot)).rejects.toThrow(/environment/i);
  });

  it("rejects minimal selection alongside custom lifecycle files", async () => {
    const snapshot = await root();
    await mkdir(join(snapshot, ".dim"));
    await writeFile(join(snapshot, ".dim", "environment.yml"), "schemaVersion: 1\nenvironment: minimal\n");
    await writeFile(join(snapshot, ".dim", "setup.sh"), "#!/bin/sh\n");

    await expect(selectWorkspaceEnvironment(snapshot)).rejects.toThrow(/minimal.*custom/i);
  });

  it("rejects symlinked environment selectors", async () => {
    const snapshot = await root();
    await mkdir(join(snapshot, ".dim"));
    await writeFile(join(snapshot, "selector.yml"), "schemaVersion: 1\nenvironment: minimal\n");
    await symlink(join(snapshot, "selector.yml"), join(snapshot, ".dim", "environment.yml"));

    await expect(selectWorkspaceEnvironment(snapshot)).rejects.toThrow(/symbolic link/i);
  });

  it("rejects environment selectors larger than the bounded contract", async () => {
    const snapshot = await root();
    await mkdir(join(snapshot, ".dim"));
    await writeFile(join(snapshot, ".dim", "environment.yml"), `schemaVersion: 1\nenvironment: minimal\n# ${"x".repeat(4_096)}\n`);

    await expect(selectWorkspaceEnvironment(snapshot)).rejects.toThrow(/4096 bytes/i);
  });

  it("rejects a mode change before reinterpreting persistent workspace data", async () => {
    const snapshot = await root();
    await mkdir(join(snapshot, ".dim"));
    await writeFile(join(snapshot, ".dim", "entrypoint.sh"), "#!/bin/sh\n");

    await expect(selectWorkspaceEnvironmentTransition({
      name: "work-1",
      environment: "recommended"
    }, snapshot)).rejects.toThrow(/changed from recommended to custom.*discard and recreate/i);
  });

  it("preserves legacy undefined environments as custom without reclassification", async () => {
    const snapshot = await root();

    await expect(selectWorkspaceEnvironmentTransition({
      name: "work-1"
    }, snapshot)).resolves.toBeUndefined();
  });

  it("rejects an ordinary root mode change before publishing new workspace state", async () => {
    const stateRoot = await root();
    const snapshot = await root();
    await mkdir(join(snapshot, ".dim"));
    await writeFile(join(snapshot, ".dim", "entrypoint.sh"), "#!/bin/sh\n");
    const state = new LifecycleState(stateRoot);
    const record = workspaceRecord();
    await state.claimWorkspace(record);

    await expect(recordSelectedRoot(state, record, {
      rootRef: "refs/heads/main",
      rootCommit: "b".repeat(40),
      rootSnapshotPath: snapshot
    })).rejects.toThrow(/changed from recommended to custom/i);
    await expect(state.readWorkspace(record.name)).resolves.toEqual(record);
  });
});

function workspaceRecord(): WorkspaceRecord {
  return {
    schemaVersion: 8, workspaceId: "A".repeat(43), name: "work-1", projectId: "project-id",
    projectName: "project", rootRepositoryAlias: "root", rootRef: "refs/heads/main",
    rootCommit: "a".repeat(40), workspaceDataPath: "/var/lib/dim/workspace-data",
    environment: "recommended", phase: "ready", profiles: [], composeProjectName: "dim-work-1",
    containerName: "dim-ws-work-1", networkName: "dim-control", dockerVolumeName: "dim-ws-work-1-docker",
    runtimeBackend: "sysbox", kvm: false, cpuCount: "2", memory: "4g", pidsLimit: "2048",
    routes: [], gitUserName: "Agent", gitUserEmail: "agent@example.invalid",
    gitBaseUrl: "http://dim-gitea:3000/dim-project", hostAliases: {},
    projectManifestPath: "/run/dim/project.json", createdAt: "now", updatedAt: "now"
  };
}
