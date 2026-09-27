import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ResolvedCiRunnerConfig } from "../../../../core/packages/core/src/ciRunnerConfig.js";
import type { CiRunnerRecord, LifecycleOptions, ProjectRecord, ProjectRepositoryRecord,
  QemuCiProjectHookProvenance, QemuCiRunnerExecutor, QemuSchedulerProjectConnection } from "../../../../core/packages/core/src/lifecycleTypes.js";
import type { PreparedQemuProjectHook, RestorePersistedQemuProjectHookInput } from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import type { ProtectedRootSnapshot } from "../../../../core/packages/core/src/protectedRootSnapshot.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";
import type { ContainerFixture } from "./ciRunnerContainerRunner.js";

const hoistedTestState = vi.hoisted(() => {
  const repository = {
    alias: "root", providerRepoId: "dim-project/root", owner: "dim-project",
    hostUrl: "http://host/root.git", workspaceUrl: "http://workspace/root.git",
    phase: "ready", connections: [], protectedPatterns: ["main"], protectionPhase: "applied",
    createdAt: "now", updatedAt: "now"
  } satisfies ProjectRepositoryRecord;
  const project = {
  schemaVersion: 4, id: "project-id", name: "project", gitNamespace: "dim-project", giteaOrganizationId: 41, phase: "ready",
    rootRepositoryAlias: "root", rootRef: "refs/heads/main", repositories: [repository],
    createdAt: "now", updatedAt: "now"
  } satisfies ProjectRecord;
  const snapshot = {
    project, repository, rootRequestedRef: "refs/heads/main", rootRef: "refs/heads/main", rootCommit: "b".repeat(40),
    rootSnapshotPath: "/current/protected-root"
  } satisfies ProtectedRootSnapshot;
  const resolvedConfig = {
    config: { schemaVersion: 1, workloads: {
      ordinary: { labels: ["current-ordinary"], image: `registry.example/ordinary@sha256:${"6".repeat(64)}`, tools: ["bash"], capabilities: [] },
      integration: { labels: ["current-integration"], image: `registry.example/current@sha256:${"7".repeat(64)}`, tools: ["bash", "docker"], capabilities: ["nested-docker"] }
    } },
    provenance: { sourceRef: snapshot.rootRef, sourceCommit: snapshot.rootCommit, configDigest: "8".repeat(64) }
  } satisfies ResolvedCiRunnerConfig;
  const currentHook = {
    sourceRef: snapshot.rootRef, sourceCommit: snapshot.rootCommit, kind: "present",
    digest: "9".repeat(64), path: "/current/hook/cache.bash"
  } satisfies PreparedQemuProjectHook;
  return {
    events: new Array<string>(), launches: new Array<readonly string[]>(), dockerCalls: new Array<readonly string[]>(),
    imageKeyInputs: new Array<{ readonly projectId: string; readonly hook: QemuCiProjectHookProvenance }>(),
    webhookFailures: new Array<Error>(),
    schedulerConnection: undefined as QemuSchedulerProjectConnection | undefined,
    project, snapshot, resolvedConfig, currentHook
  };
});
export const testState = hoistedTestState;

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>(), statSync: vi.fn(() => ({ gid: 108 })) }));
vi.mock("../../../../core/packages/core/src/protectedRootSnapshot.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/protectedRootSnapshot.js")>(),
  resolveProtectedRootSnapshotLocked: vi.fn(async () => { hoistedTestState.events.push("current:root"); return hoistedTestState.snapshot; })
}));
vi.mock("../../../../core/packages/core/src/ciRunnerConfig.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/ciRunnerConfig.js")>(),
  loadCiRunnerConfig: vi.fn(async () => { hoistedTestState.events.push("current:config"); return hoistedTestState.resolvedConfig; })
}));
vi.mock("../../../../core/packages/core/src/qemuCiRunnerImage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../core/packages/core/src/qemuCiRunnerImage.js")>();
  return {
    ...actual,
    prepareQemuProjectHookFromSnapshot: vi.fn(async () => { hoistedTestState.events.push("current:hook"); return hoistedTestState.currentHook; }),
    restorePersistedQemuProjectHook: vi.fn(async (input: RestorePersistedQemuProjectHookInput) => {
      hoistedTestState.events.push("persisted:hook"); return actual.restorePersistedQemuProjectHook(input);
    })
  };
});
vi.mock("../../../../core/packages/core/src/qemuCiRunnerSupervisorImage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../core/packages/core/src/qemuCiRunnerSupervisorImage.js")>();
  return {
    ...actual,
    qemuCiRunnerProductionImageKeys: vi.fn((input: { readonly projectId: string; readonly hook: QemuCiProjectHookProvenance }) => {
      hoistedTestState.events.push("persisted:image-keys"); hoistedTestState.imageKeyInputs.push(input);
      return actual.qemuCiRunnerProductionImageKeys(input);
    }),
    prepareQemuCiRunnerSupervisorImage: vi.fn(async () => { hoistedTestState.events.push("current:supervisor-image"); return `sha256:${"f".repeat(64)}`; })
  };
});
vi.mock("../../../../core/packages/core/src/qemuSchedulerConnection.js", () => ({
  qemuSchedulerConnection: vi.fn(async () => {
    hoistedTestState.events.push("current:scheduler");
    return hoistedTestState.schedulerConnection;
  })
}));
vi.mock("../../../../core/packages/core/src/sysboxCiRunnerLifecycle.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/sysboxCiRunnerLifecycle.js")>(),
  resolveSysboxRunnerImage: vi.fn(async () => { hoistedTestState.events.push("current:host-image"); return `sha256:${"5".repeat(64)}`; })
}));
vi.mock("../../../../core/packages/core/src/ciRunnerResources.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/ciRunnerResources.js")>(),
  detectCiRunnerKvm: vi.fn(async () => { hoistedTestState.events.push("runtime:kvm"); return true; }),
  effectiveQemuCiRunnerResources: vi.fn(() => {
    hoistedTestState.events.push("current:defaults"); return { resources: { cpus: "8", memory: "16GiB" }, inheritsResources: true };
  })
}));
vi.mock("../../../../core/packages/core/src/ciRunnerProbe.js", () => ({ probeCiRunnerWorkloads: vi.fn(async () => { hoistedTestState.events.push("current:probes"); }) }));
vi.mock("../../../../core/packages/core/src/registryCache.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/registryCache.js")>(), ensureRegistryCache: vi.fn(async () => { hoistedTestState.events.push("runtime:cache"); })
}));
vi.mock("../../../../core/packages/core/src/ciRunnerVolume.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/ciRunnerVolume.js")>(),
  ensureCiRunnerVolume: vi.fn(async (_runner: StreamingCommandRunner, plan: { readonly resource: string }) => { hoistedTestState.events.push(`runtime:volume:${plan.resource}`); })
}));
vi.mock("../../../../core/packages/core/src/giteaCiCoordinator.js", () => ({
  giteaCiCoordinator: {
    removeWorkflowJobWebhook: vi.fn(async () => { hoistedTestState.events.push("runtime:remove-webhook"); }),
    removeRunner: vi.fn(async () => { hoistedTestState.events.push("runtime:remove-registration"); }),
    prepareRunner: vi.fn(async () => {
      hoistedTestState.events.push("runtime:register"); return { provider: "fresh-provider", instanceUrl: "http://fresh-coordinator", token: "fresh-registration" };
    }),
    ensureWorkflowJobWebhook: vi.fn(async (_runner: StreamingCommandRunner, _options: LifecycleOptions, _project: ProjectRecord, input: {
      readonly authorizationHeader: string;
      readonly replayQueuedJob: (job: { readonly id: number; readonly labels: readonly string[] }) => Promise<void>;
    }) => {
      hoistedTestState.events.push(`runtime:webhook:${input.authorizationHeader}`);
      hoistedTestState.events.push("runtime:query-backlog");
      const failure = hoistedTestState.webhookFailures.shift();
      if (failure !== undefined) throw failure;
      await input.replayQueuedJob({ id: 991, labels: ["persisted-integration", "dim-qemu"] });
    }),
    reconcileWorkflowJobWebhookTargets: vi.fn(async () => {})
  }
}));

import { createCiRunner, restartCiRunner, startCiRunner } from "../../../../core/packages/core/src/ciRunner.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";

export const options = {
  stateRoot: "", giteaConnection: { kind: "managed" }, giteaImage: "gitea", giteaHost: "gitea", giteaPort: 3000,
  giteaAdminUsername: "admin", gitUsername: "writer", gitMaintainerUsername: "maintainer",
  defaultWorkspaceBackend: "sysbox", cpuCount: "4", memory: "8GiB", pidsLimit: "2048",
  controllerRuntimeDirectory: "/run/dim", controllerSocketPath: "/run/dim/controller.sock",
  agentControllerSocketPath: "/run/dim/agent.sock", adminControllerSocketPath: "/run/dim/admin.sock",
  ciRunnerImage: "dev-infra-manager-ci-runner:act-runner-minimal-v2", ciRunnerRuntime: "sysbox-runc",
  ciRunnerDefaultCpus: "4", ciRunnerDefaultMemory: "8GiB", ciRunnerDefaultPidsLimit: "2048"
} satisfies LifecycleOptions;

const persistedHookBytes = Buffer.from("#!/usr/bin/env bash\necho persisted\n");
export const persistedHook = {
  sourceRef: "refs/heads/admitted", sourceCommit: "a".repeat(40), kind: "present",
  digest: createHash("sha256").update(persistedHookBytes).digest("hex")
} as const;
export const stoppedSupervisorLabels = [
  "dim.managed=true", "dim.owner=dim", "dim.project=project", "dim.project-id=project-id",
  "dim.capacity=runner", "dim.executor=qemu", "dim.resource=ci-qemu-supervisor",
  "dim.kind=container", "dim.digest=97a0ab0858111e3287e3716ec1139af7c1bc0423ba5d50cf7f857482d94cec24"
] as const;
export const reconciledSupervisorLabels = [
  "dim.managed=true", "dim.owner=dim", "dim.project=project", "dim.project-id=project-id",
  "dim.capacity=runner", "dim.executor=qemu", "dim.resource=ci-qemu-supervisor",
  "dim.kind=container", "dim.digest=1ad352bf3222ed69b2f511d2e941fc5e68c6fcd1eec852573d2df65940ff7229"
] as const;

export type QemuCiRunnerRecord = Omit<CiRunnerRecord, "executor"> & { readonly executor: QemuCiRunnerExecutor };
export type QemuStartContext = { readonly stateRoot: string; readonly state: LifecycleState; readonly record: QemuCiRunnerRecord };
export type ReconciliationMode = "start" | "restart" | "create";

export class StartRunner implements StreamingCommandRunner {
  private launchedContainer: { readonly id: string; readonly name: string; readonly labels: readonly string[] } | undefined;
  constructor(private readonly container?: ContainerFixture) {}
  async run(command: string, args: string[]): Promise<CommandResult> {
    testState.dockerCalls.push([command, ...args]);
    if (command === "docker" && args[0] === "container" && args[1] === "inspect") {
      if (this.container !== undefined) {
        const values = this.container.labels.map((label) => label.slice(label.indexOf("=") + 1));
        return { command, args, stdout: `${[this.container.id, ...values].join("|")}\n`, stderr: "", exitCode: 0 };
      }
      const launchedContainer = this.launchedContainer;
      if (launchedContainer !== undefined && launchedContainer.name === args[2]) {
        const values = launchedContainer.labels.map((label) => label.slice(label.indexOf("=") + 1));
        return { command, args, stdout: `${[launchedContainer.id, ...values].join("|")}\n`, stderr: "", exitCode: 0 };
      }
      return { command, args, stdout: "", stderr: `Error: No such object: ${args[2] ?? ""}`, exitCode: 1 };
    }
    if (command === "docker" && args[0] === "container" && args[1] === "rm") testState.events.push("runtime:remove-container");
    if (command === "docker" && args[0] === "run") {
      testState.events.push("runtime:launch"); testState.launches.push(args);
      const nameIndex = args.indexOf("--name");
      this.launchedContainer = {
        id: "immutable-supervisor-id",
        name: args[nameIndex + 1] ?? "",
        labels: args.flatMap((argument, index) => args[index - 1] === "--label" ? [argument] : [])
      };
    }
    if (command === "docker" && args[0] === "exec") {
      const url = args.at(-1);
      if (url === "http://127.0.0.1:8080/healthz") testState.events.push("runtime:health");
      if (url === "http://127.0.0.1:8080/workflow-job") testState.events.push("runtime:replay");
    }
    return { command, args, stdout: "", stderr: "", exitCode: 0 };
  }
  async runStreaming(): Promise<number> { return 0; }
}

export async function setUpQemuStartTest(): Promise<QemuStartContext> {
  testState.events.length = 0; testState.launches.length = 0; testState.dockerCalls.length = 0;
  testState.imageKeyInputs.length = 0; testState.webhookFailures.length = 0; testState.schedulerConnection = undefined;
  const stateRoot = await mkdtemp(join(tmpdir(), "dim-ci-runner-start-"));
  options.stateRoot = stateRoot;
  const state = new LifecycleState(stateRoot);
  const record = stoppedRecord();
  await state.claimProject(testState.project); await state.writeCiRunner(record); await writePersistedHook(stateRoot, record.projectId);
  vi.spyOn(LifecycleState.prototype, "acquireProjectLock").mockImplementation(async () => {
    testState.events.push("lock:project"); return async () => { testState.events.push("unlock:project"); };
  });
  vi.spyOn(LifecycleState.prototype, "acquireCiRunnerLock").mockImplementation(async () => {
    testState.events.push("lock:runner"); return async () => { testState.events.push("unlock:runner"); };
  });
  return { stateRoot, state, record };
}

export async function tearDownQemuStartTest(context: QemuStartContext): Promise<void> {
  vi.restoreAllMocks(); await rm(context.stateRoot, { recursive: true, force: true });
}

export async function reconcileWithFixture(mode: ReconciliationMode, runner: StartRunner, context: QemuStartContext): Promise<CiRunnerRecord> {
  if (mode === "create") await context.state.removeCiRunner(context.record.projectName, context.record.name);
  if (mode === "start") return startCiRunner(runner, options, { project: context.record.projectName, name: context.record.name });
  if (mode === "restart") return restartCiRunner(runner, options, { project: context.record.projectName, name: context.record.name });
  return createCiRunner(runner, options, { project: context.record.projectName, name: context.record.name, executor: "qemu" });
}

function stoppedRecord(): QemuCiRunnerRecord {
  return {
    schemaVersion: 8, name: "runner", projectId: testState.project.id, projectName: testState.project.name,
    provider: "stale-provider",
    config: { sourceRef: persistedHook.sourceRef, sourceCommit: persistedHook.sourceCommit, configDigest: "c".repeat(64) },
    executor: {
      kind: "qemu", phase: "stopped", supervisorName: "persisted-supervisor", volumeName: "persisted-volume",
      image: `sha256:${"e".repeat(64)}`, projectHook: persistedHook,
      resources: { cpus: "3", memory: "5GiB" }, inheritsResources: true,
      labels: ["persisted-integration", "dim-qemu"],
      jobImage: `registry.example/persisted@sha256:${"d".repeat(64)}`, updatedAt: "persisted-executor-time"
    },
    createdAt: "persisted-created-time", updatedAt: "persisted-record-time"
  };
}

async function writePersistedHook(stateRoot: string, projectId: string): Promise<void> {
  const directory = join(stateRoot, "assets", "qemu-ci-projects", projectId, "hooks", persistedHook.sourceCommit, `${persistedHook.kind}-${persistedHook.digest}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "cache.bash"), persistedHookBytes);
  await writeFile(join(directory, "provenance.json"), `${JSON.stringify(persistedHook, null, 2)}\n`);
  await chmod(join(directory, "cache.bash"), 0o500);
}
