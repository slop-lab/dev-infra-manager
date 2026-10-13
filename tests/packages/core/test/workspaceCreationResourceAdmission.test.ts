import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { ProjectRecord, WorkspaceRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { RegisteredWorkspaceCapabilityProvider } from "../../../../core/packages/core/src/plugin.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { createWorkspace } from "../../../../core/packages/core/src/workspaceCreation.js";
import { projectFixture, options as managedOptions } from "./workspaceUpdateLockFixture.js";

const creation = vi.hoisted(() => ({
  managedSnapshotRoot: "",
  managedProject: undefined as ProjectRecord | undefined,
  nativeSnapshotRoot: "",
  provision: vi.fn(async () => ({}))
}));

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  ensureGitea: vi.fn(async () => ({ kind: "managed", adminUsername: "admin", adminPassword: "admin",
    writerUsername: "writer", writerPassword: "writer", maintainerUsername: "maintainer", maintainerPassword: "maintainer" })),
  giteaNestedBaseUrl: vi.fn(async () => "http://dim-gitea:3000")
}));

vi.mock("../../../../core/packages/core/src/protectedRootSnapshot.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/protectedRootSnapshot.js")>(),
  resolveProtectedRootSnapshot: vi.fn(async () => managedSelection(creation.managedSnapshotRoot))
}));

vi.mock("../../../../core/packages/core/src/nativeControlPlaneConnection.js", () => ({
  loadNativeControlPlaneConnection: vi.fn(async () => ({ hostId: "native-host" }))
}));

vi.mock("../../../../core/packages/core/src/nativeProjectPendingStore.js", () => ({
  NativeProjectPendingStore: class {
    async read(): Promise<ReturnType<typeof nativeProject>> { return nativeProject(); }
  }
}));

vi.mock("../../../../core/packages/core/src/nativeProjectReadinessClient.js", () => ({
  proveNativeProjectReadiness: vi.fn(async () => nativeProof())
}));

vi.mock("../../../../core/packages/core/src/nativeProjectRootSelection.js", () => ({
  materializeNativeProjectReadinessRoot: vi.fn(async () => {
    await mkdir(creation.nativeSnapshotRoot, { recursive: true });
  })
}));

vi.mock("../../../../core/packages/core/src/workspaceSetup.js", () => ({
  reconcileProject: vi.fn(async (
    _runner: unknown,
    _options: unknown,
    _state: unknown,
    record: WorkspaceRecord
  ) => record),
  reconcileNativeWorkspace: vi.fn(async (
    _runner: unknown,
    _options: unknown,
    _state: unknown,
    record: WorkspaceRecord
  ) => record),
  setupWorkspaceLocked: vi.fn(async (
    _runner: unknown,
    _options: unknown,
    _state: unknown,
    record: WorkspaceRecord
  ) => record)
}));

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace creation resource admission", () => {
  it.each([
    ["below minimum", { cpuCount: "0.5", memory: "512m", pidsLimit: "128" }],
    ["excess CPU precision", { cpuCount: "1.0000000001", memory: "1g", pidsLimit: "256" }]
  ] as const)("rejects recommended managed resources %s before mutation and accepts a corrected retry", async (_case, invalid) => {
    // Given
    const root = await managedFixture();
    const state = new LifecycleState(root);
    const calls: string[][] = [];
    const plugins = capabilityPlugins();

    // When / Then
    await expect(createWorkspace(recordingRunner(calls), managedOptions(root), request("managed-work", invalid), plugins))
      .rejects.toThrow(/recommended workspace|decimal places/);
    await expect(state.readWorkspace("managed-work")).rejects.toThrow(/not found/);
    for (const audience of ["workspace", "agent", "native-git"]) {
      await expect(readdir(join(root, `${audience}-grants`))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(creation.provision).not.toHaveBeenCalled();
    expect(calls).toEqual([]);

    const corrected = await createWorkspace(recordingRunner(calls), managedOptions(root), request("managed-work", {
      cpuCount: "1", memory: "1g", pidsLimit: "256"
    }), plugins);
    expect(corrected).toMatchObject({ name: "managed-work", environment: "recommended" });
    await expect(state.readWorkspace("managed-work")).resolves.toMatchObject({ cpuCount: "1", memory: "1g", pidsLimit: "256" });
    expect(creation.provision).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("rejects a recommended native budget before capability or workspace mutation and accepts a corrected retry", async () => {
    // Given
    const root = await nativeFixture();
    const state = new LifecycleState(root);
    const calls: string[][] = [];
    const plugins = capabilityPlugins();
    const options = {
      ...lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }),
      nativeControlPlaneConnection: { file: join(root, "native-control.json") }
    };

    // When / Then
    await expect(createWorkspace(recordingRunner(calls), options, request("native-work", {
      cpuCount: "0.5", memory: "512m", pidsLimit: "128"
    }), plugins)).rejects.toThrow(/recommended workspace resources/);
    await expect(state.readWorkspace("native-work")).rejects.toThrow(/not found/);
    for (const audience of ["workspace", "agent", "native-git"]) {
      await expect(readdir(join(root, `${audience}-grants`))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(creation.provision).not.toHaveBeenCalled();
    expect(calls).toEqual([]);

    const corrected = await createWorkspace(recordingRunner(calls), options, request("native-work", {
      cpuCount: "1", memory: "1g", pidsLimit: "256"
    }), plugins);
    expect(corrected).toMatchObject({ schemaVersion: 9, name: "native-work", environment: "recommended" });
    await expect(state.readWorkspace("native-work")).resolves.toMatchObject({ cpuCount: "1", memory: "1g", pidsLimit: "256" });
    expect(creation.provision).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });
});

function request(name: string, resources: { readonly cpuCount: string; readonly memory: string; readonly pidsLimit: string }) {
  return { project: "project", name, profiles: [], requiredCapabilities: ["test-capability"],
    runtimeBackend: "sysbox" as const, ...resources };
}

function capabilityPlugins(): { readonly workspaceCapabilityProviders: ReadonlyMap<string, RegisteredWorkspaceCapabilityProvider> } {
  return { workspaceCapabilityProviders: new Map([
    ["test-capability", { plugin: "test-plugin", provider: { provision: creation.provision } }]
  ]) };
}

async function managedFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-managed-resource-admission-"));
  roots.push(root);
  creation.managedSnapshotRoot = join(root, "assets", "project-roots", "project-id", "a".repeat(40));
  await mkdir(creation.managedSnapshotRoot, { recursive: true });
  const state = new LifecycleState(root);
  await state.claimProject(projectFixture());
  creation.managedProject = await state.readProject("project");
  return root;
}

async function nativeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-resource-admission-"));
  roots.push(root);
  creation.nativeSnapshotRoot = join(root, "assets", "native-project-roots", "native-project-id", "b".repeat(40));
  return root;
}

function managedSelection(rootSnapshotPath: string) {
  const project = creation.managedProject;
  if (project === undefined) throw new Error("managed fixture project is missing");
  const repository = project.repositories[0];
  if (repository === undefined) throw new Error("managed fixture root repository is missing");
  return { project, repository, rootRequestedRef: "refs/heads/main", rootRef: "refs/heads/main",
    rootCommit: "a".repeat(40), rootSnapshotPath };
}

function nativeProject() {
  return { phase: "ready" as const, name: "project", projectId: "native-project-id", rootAlias: "root",
    protectedRef: "refs/heads/main", rootCommit: "b".repeat(40), rootTree: "c".repeat(40), serviceId: "native-main",
    reviewPolicy: { policyRevision: "d".repeat(64), requiredReviewRevision: "e".repeat(64),
      requiredJobSetRevision: "f".repeat(64) } };
}

function nativeProof() {
  return { protectedRef: "refs/heads/main", commit: "b".repeat(40), tree: "c".repeat(40) };
}

function recordingRunner(calls: string[][]): StreamingCommandRunner {
  return {
    async run(command, args): Promise<CommandResult> {
      calls.push([command, ...args]);
      return { command, args, stdout: "", stderr: "unexpected runtime mutation", exitCode: 1 };
    },
    async runStreaming(command, args) {
      calls.push([command, ...args]);
      return 1;
    }
  };
}
