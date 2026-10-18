import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/managed/src/lifecycleOptions.js";
import { LifecycleState } from "../../../../core/packages/managed/src/lifecycleState.js";
import type { WorkspaceRecord } from "../../../../core/packages/managed/src/lifecycleTypes.js";
import type { RegisteredWorkspaceCapabilityProvider } from "../../../../core/packages/managed/src/plugin.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import { createWorkspace } from "../../../../core/packages/managed/src/workspaceCreation.js";

const creation = vi.hoisted(() => ({
  nativeSnapshotRoot: "",
  provision: vi.fn(async () => ({})),
  setup: vi.fn(async (
    _runner: unknown,
    _options: unknown,
    _state: unknown,
    record: WorkspaceRecord
  ) => record)
}));

vi.mock("../../../../core/packages/managed/src/nativeControlPlaneConnection.js", () => ({
  loadNativeControlPlaneConnection: vi.fn(async () => ({ hostId: "native-host" }))
}));

vi.mock("../../../../core/packages/managed/src/nativeProjectPendingStore.js", () => ({
  NativeProjectPendingStore: class {
    async read(): Promise<ReturnType<typeof nativeProject>> { return nativeProject(); }
  }
}));

vi.mock("../../../../core/packages/managed/src/nativeProjectReadinessClient.js", () => ({
  proveNativeProjectReadiness: vi.fn(async () => nativeProof())
}));

vi.mock("../../../../core/packages/managed/src/nativeProjectRootSelection.js", () => ({
  materializeNativeProjectReadinessRoot: vi.fn(async () => {
    await mkdir(creation.nativeSnapshotRoot, { recursive: true });
  })
}));

vi.mock("../../../../core/packages/managed/src/workspaceSetup.js", () => ({
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
  setupWorkspaceLocked: creation.setup
}));

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace creation resource admission", () => {
  it("holds the Project and setup locks until native workspace setup settles", async () => {
    // Given
    const root = await nativeFixture();
    const setupStarted = deferred();
    const setupFinished = deferred();
    const releaseProject = vi.fn(async () => undefined);
    const releaseSetup = vi.fn(async () => undefined);
    vi.spyOn(LifecycleState.prototype, "acquireProjectLock").mockResolvedValueOnce(releaseProject);
    vi.spyOn(LifecycleState.prototype, "acquireWorkspaceSetupLock").mockResolvedValueOnce(releaseSetup);
    creation.setup.mockImplementationOnce(async (
      _runner: unknown,
      _options: unknown,
      _state: unknown,
      record: WorkspaceRecord
    ) => {
      setupStarted.resolve();
      await setupFinished.promise;
      return record;
    });
    const options = {
      ...lifecycleOptionsForBackend("sysbox", { DIM_STATE_ROOT: root }),
      nativeControlPlaneConnection: { file: join(root, "native-control.json") }
    };

    // When
    const creationPromise = createWorkspace(
      recordingRunner([]),
      options,
      request("native-work", { cpuCount: "1", memory: "1g", pidsLimit: "256" }),
      capabilityPlugins()
    );
    await setupStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Then
    const releaseCountsBeforeSetupSettled = [releaseProject.mock.calls.length, releaseSetup.mock.calls.length];
    setupFinished.resolve();
    await expect(creationPromise).resolves.toMatchObject({ name: "native-work", phase: "creating" });
    expect(releaseCountsBeforeSetupSettled).toEqual([0, 0]);
    expect(releaseProject).toHaveBeenCalledTimes(1);
    expect(releaseSetup).toHaveBeenCalledTimes(1);
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

async function nativeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-resource-admission-"));
  roots.push(root);
  creation.nativeSnapshotRoot = join(root, "assets", "native-project-roots", "native-project-id", "b".repeat(40));
  return root;
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

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { resolver = resolve; });
  return {
    promise,
    resolve() {
      if (resolver === undefined) throw new TypeError("deferred resolver is unavailable");
      resolver();
    }
  };
}
