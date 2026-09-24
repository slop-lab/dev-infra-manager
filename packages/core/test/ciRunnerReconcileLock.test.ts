import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CiRunnerConfig, ResolvedCiRunnerConfig } from "../../../../core/packages/core/src/ciRunnerConfig.js";
import type {
  CiRunnerRecord,
  LifecycleOptions,
  ProjectRecord,
  ProjectRepositoryRecord
} from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { PreparedQemuProjectHook } from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import type { ProtectedRootSnapshot } from "../../../../core/packages/core/src/protectedRootSnapshot.js";
import type { StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const testState = vi.hoisted(() => {
  const repository = {
    alias: "root",
    providerRepoId: "dim-project/root",
    owner: "dim-project",
    hostUrl: "http://host/root.git",
    workspaceUrl: "http://workspace/root.git",
    phase: "ready",
    connections: [],
    protectedPatterns: ["main"],
    protectionPhase: "applied",
    createdAt: "now",
    updatedAt: "now"
  } satisfies ProjectRepositoryRecord;
  const project = {
  schemaVersion: 4,
    id: "project-id",
    name: "project",
  gitNamespace: "dim-project",
  giteaOrganizationId: 41,
    phase: "ready",
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    repositories: [repository],
    createdAt: "now",
    updatedAt: "now"
  } satisfies ProjectRecord;
  const snapshot = {
    project,
    repository,
    rootRequestedRef: "refs/heads/main",
    rootRef: "refs/heads/main",
    rootCommit: "a".repeat(40),
    rootSnapshotPath: "/state/snapshots/project"
  } satisfies ProtectedRootSnapshot;
  const config = {
    schemaVersion: 1,
    workloads: {
      ordinary: {
        labels: ["dim"],
        image: `registry.example/runner@sha256:${"b".repeat(64)}`,
        tools: ["bash"],
        capabilities: []
      },
      integration: {
        labels: ["dim-container-integration"],
        image: `registry.example/runner@sha256:${"c".repeat(64)}`,
        tools: ["bash", "docker"],
        capabilities: ["nested-docker"]
      }
    }
  } satisfies CiRunnerConfig;
  const resolvedConfig = {
    config,
    provenance: {
      sourceRef: snapshot.rootRef,
      sourceCommit: snapshot.rootCommit,
      configDigest: "d".repeat(64)
    }
  } satisfies ResolvedCiRunnerConfig;
  const projectHook = {
    sourceRef: snapshot.rootRef,
    sourceCommit: snapshot.rootCommit,
    kind: "present",
    digest: "e".repeat(64),
    path: "/state/hooks/cache.bash"
  } satisfies PreparedQemuProjectHook;

  return {
    events: [] as string[],
    snapshotConsumers: [] as ProtectedRootSnapshot[],
    hostImageThrows: false,
    imagePreparationSentinel: new Error("image preparation sentinel"),
    project,
    snapshot,
    resolvedConfig,
    projectHook
  };
});

vi.mock("../../../../core/packages/core/src/lifecycleState.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../core/packages/core/src/lifecycleState.js")>();
  const { MissingRecordError } = await import("../../../../core/packages/core/src/errors.js");

  return {
    ...actual,
    LifecycleState: class {
      async acquireProjectLock(): Promise<() => Promise<void>> {
        testState.events.push("project:lock");
        return async () => { testState.events.push("project:unlock"); };
      }

      async acquireCiRunnerLock(): Promise<() => Promise<void>> {
        testState.events.push("ci-runner:lock");
        return async () => { testState.events.push("ci-runner:unlock"); };
      }

      async readProject(): Promise<ProjectRecord> {
        return testState.project;
      }

      async readCiRunner(): Promise<CiRunnerRecord> {
        throw new MissingRecordError("CI runner 'project/runner' not found");
      }

      async writeCiRunner(): Promise<void> {}
    }
  };
});

vi.mock("../../../../core/packages/core/src/protectedRootSnapshot.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/protectedRootSnapshot.js")>(),
  resolveProtectedRootSnapshotLocked: vi.fn(async () => {
    testState.events.push("snapshot");
    return testState.snapshot;
  })
}));

vi.mock("../../../../core/packages/core/src/ciRunnerConfig.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/ciRunnerConfig.js")>(),
  loadCiRunnerConfig: vi.fn(async (snapshot: ProtectedRootSnapshot) => {
    testState.events.push("config");
    testState.snapshotConsumers.push(snapshot);
    return testState.resolvedConfig;
  })
}));

vi.mock("../../../../core/packages/core/src/qemuCiRunnerImage.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/qemuCiRunnerImage.js")>(),
  prepareQemuProjectHookFromSnapshot: vi.fn(async (input: {
    readonly stateRoot: string;
    readonly snapshot: ProtectedRootSnapshot;
  }) => {
    testState.events.push("hook:start");
    testState.snapshotConsumers.push(input.snapshot);
    testState.events.push("hook:finish");
    return testState.projectHook;
  })
}));

vi.mock("../../../../core/packages/core/src/qemuCiRunnerSupervisorImage.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/qemuCiRunnerSupervisorImage.js")>(),
  prepareQemuCiRunnerSupervisorImage: vi.fn(async () => {
    testState.events.push("qemu:supervisor-image");
    throw testState.imagePreparationSentinel;
  })
}));

vi.mock("../../../../core/packages/core/src/sysboxCiRunnerLifecycle.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/sysboxCiRunnerLifecycle.js")>(),
  resolveSysboxRunnerImage: vi.fn(async () => {
    testState.events.push("host-image");
    if (testState.hostImageThrows) throw testState.imagePreparationSentinel;
    return `sha256:${"f".repeat(64)}`;
  })
}));

vi.mock("../../../../core/packages/core/src/ciRunnerResources.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/ciRunnerResources.js")>(),
  detectCiRunnerKvm: vi.fn(async () => true)
}));

import { createCiRunner } from "../../../../core/packages/core/src/ciRunner.js";

const options = {
  stateRoot: "/state",
  giteaConnection: { kind: "managed" },
  giteaImage: "gitea",
  giteaHost: "gitea",
  giteaPort: 3000,
  giteaAdminUsername: "admin",
  gitUsername: "writer",
  gitMaintainerUsername: "maintainer",
  defaultWorkspaceBackend: "sysbox",
  cpuCount: "4",
  memory: "8GiB",
  pidsLimit: "2048",
  controllerRuntimeDirectory: "/run/dim",
  controllerSocketPath: "/run/dim/controller.sock",
  agentControllerSocketPath: "/run/dim/agent.sock",
  adminControllerSocketPath: "/run/dim/admin.sock",
  ciRunnerImage: "dev-infra-manager-ci-runner:act-runner-minimal-v2",
  ciRunnerRuntime: "sysbox-runc",
  ciRunnerDefaultCpus: "4",
  ciRunnerDefaultMemory: "8GiB",
  ciRunnerDefaultPidsLimit: "2048"
} satisfies LifecycleOptions;

const runner = {
  async run(command: string, args: string[]) {
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  },
  async runStreaming() {
    return 0;
  }
} satisfies StreamingCommandRunner;

beforeEach(() => {
  testState.events.length = 0;
  testState.snapshotConsumers.length = 0;
  testState.hostImageThrows = false;
});

describe("CI runner reconciliation lock scope", () => {
  it("releases the Project lock before resolving the Sysbox host image while retaining the CI-runner lock", async () => {
    // Given
    testState.hostImageThrows = true;

    // When
    const creation = createCiRunner(runner, options, {
      project: "project",
      name: "runner",
      executor: "sysbox"
    });

    // Then
    await expect(creation).rejects.toBe(testState.imagePreparationSentinel);
    expect(testState.events.filter((event) => event === "project:lock")).toHaveLength(1);
    expect(testState.events.filter((event) => event === "ci-runner:lock")).toHaveLength(1);
    expect(testState.events.filter((event) => event === "project:unlock")).toHaveLength(1);
    expect(testState.events.filter((event) => event === "ci-runner:unlock")).toHaveLength(1);
    expect.soft(testState.events.indexOf("project:unlock")).toBeLessThan(testState.events.indexOf("host-image"));
    expect(testState.events.indexOf("host-image")).toBeLessThan(testState.events.indexOf("ci-runner:unlock"));
  });

  it("admits one QEMU snapshot under the Project lock and prepares host images after releasing it", async () => {
    // Given
    const admittedSnapshot = testState.snapshot;

    // When
    const creation = createCiRunner(runner, options, {
      project: "project",
      name: "runner",
      executor: "qemu"
    });

    // Then
    await expect(creation).rejects.toBe(testState.imagePreparationSentinel);
    expect(testState.snapshotConsumers).toHaveLength(2);
    expect(testState.snapshotConsumers.every((snapshot) => snapshot === admittedSnapshot)).toBe(true);
    expect(testState.events.indexOf("config")).toBeLessThan(testState.events.indexOf("hook:start"));
    expect(testState.events.indexOf("hook:finish")).toBeLessThan(testState.events.indexOf("project:unlock"));
    expect.soft(testState.events.indexOf("project:unlock")).toBeLessThan(testState.events.indexOf("host-image"));
    expect.soft(testState.events.indexOf("project:unlock")).toBeLessThan(testState.events.indexOf("qemu:supervisor-image"));
    expect(testState.events.filter((event) => event === "project:lock")).toHaveLength(1);
    expect(testState.events.filter((event) => event === "ci-runner:lock")).toHaveLength(1);
    expect(testState.events.filter((event) => event === "project:unlock")).toHaveLength(1);
    expect(testState.events.filter((event) => event === "ci-runner:unlock")).toHaveLength(1);
    expect(testState.events.indexOf("host-image")).toBeLessThan(testState.events.indexOf("ci-runner:unlock"));
    expect(testState.events.indexOf("qemu:supervisor-image")).toBeLessThan(testState.events.indexOf("ci-runner:unlock"));
  });
});
