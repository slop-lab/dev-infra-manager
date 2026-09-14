import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteCiRunner } from "../../../../core/packages/core/src/ciRunner.js";
import { giteaCiCoordinator } from "../../../../core/packages/core/src/giteaCiCoordinator.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CiRunnerRecord, LifecycleOptions, ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  containerLabelMismatchCases,
  EXPECTED_CONTAINER_LABELS
} from "./ciRunnerContainerFixture.js";
import { StatefulContainerRunner } from "./ciRunnerContainerRunner.js";

const PROJECT = {
  schemaVersion: 4,
  id: "project-id",
  name: "example",
  gitNamespace: "dim-example",
  giteaOrganizationId: 41,
  phase: "ready",
  rootRepositoryAlias: "root",
  rootRef: "main",
  repositories: [],
  createdAt: "now", updatedAt: "now"
} satisfies ProjectRecord;

type DeletionCase = {
  readonly label: string;
  readonly record: CiRunnerRecord;
  readonly containerName: string;
  readonly executor: "sysbox" | "qemu";
  readonly resource: "ci-runner" | "ci-qemu-supervisor";
};

const sysboxRecord = {
  schemaVersion: 8,
  name: "sysbox-capacity",
  projectId: PROJECT.id,
  projectName: PROJECT.name,
  provider: "gitea-actions",
  config: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64) },
  executor: {
    kind: "sysbox",
    phase: "ready",
    containerName: "shared-sysbox-name",
    volumeName: "sysbox-data",
    image: `sha256:${"c".repeat(64)}`,
    runtime: "sysbox-runc",
    resources: { cpus: "4", memory: "8g", pidsLimit: "2048" },
    inheritsResources: true,
    labels: ["dim"],
    updatedAt: "now"
  },
  createdAt: "now", updatedAt: "now"
} satisfies CiRunnerRecord;

const qemuRecord = {
  schemaVersion: 8,
  name: "qemu-capacity",
  projectId: PROJECT.id,
  projectName: PROJECT.name,
  provider: "gitea-actions",
  config: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64) },
  executor: {
    kind: "qemu",
    phase: "ready",
    supervisorName: "shared-qemu-name",
    volumeName: "qemu-data",
    image: `sha256:${"c".repeat(64)}`,
    projectHook: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), kind: "absent", digest: "d".repeat(64) },
    resources: { cpus: "4", memory: "8g" },
    inheritsResources: true,
    labels: ["dim-container-integration", "dim-qemu"],
    jobImage: `registry.example/job@sha256:${"e".repeat(64)}`,
    updatedAt: "now"
  },
  createdAt: "now", updatedAt: "now"
} satisfies CiRunnerRecord;

const deletionCases = [
  {
    label: "Sysbox runner",
    record: sysboxRecord,
    containerName: sysboxRecord.executor.containerName,
    executor: "sysbox",
    resource: "ci-runner"
  },
  {
    label: "QEMU supervisor",
    record: qemuRecord,
    containerName: qemuRecord.executor.supervisorName,
    executor: "qemu",
    resource: "ci-qemu-supervisor"
  }
] satisfies readonly DeletionCase[];

const ownershipCases = deletionCases.flatMap((testCase) =>
  containerLabelMismatchCases(EXPECTED_CONTAINER_LABELS[testCase.executor])
    .map((mismatch) => ({ ...testCase, ...mismatch }))
);

describe("CI runner container deletion ownership", () => {
  let root = "";
  let state: LifecycleState;
  let options: LifecycleOptions;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-ci-container-delete-"));
    state = new LifecycleState(root);
    options = {
      stateRoot: root,
      giteaImage: "gitea",
      giteaHost: "gitea",
      giteaPort: 3000,
      giteaAdminUsername: "admin",
      gitUsername: "writer",
      gitMaintainerUsername: "maintainer",
      defaultWorkspaceBackend: "sysbox",
      cpuCount: "4",
      memory: "8g",
      pidsLimit: "2048",
      controllerRuntimeDirectory: "/run/dim",
      controllerSocketPath: "/run/dim/controller.sock",
      agentControllerSocketPath: "/run/dim/agent.sock",
      adminControllerSocketPath: "/run/dim/admin.sock",
      ciRunnerImage: "runner",
      ciRunnerRuntime: "sysbox-runc",
      ciRunnerDefaultCpus: "4",
      ciRunnerDefaultMemory: "8g",
      ciRunnerDefaultPidsLimit: "2048"
    };
    await state.claimProject(PROJECT);
    vi.spyOn(giteaCiCoordinator, "removeWorkflowJobWebhook").mockResolvedValue();
    vi.spyOn(giteaCiCoordinator, "removeRunner").mockResolvedValue();
    vi.spyOn(giteaCiCoordinator, "reconcileWorkflowJobWebhookTargets").mockResolvedValue();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each(ownershipCases)("rejects an independent $field mismatch for a $label", async (testCase) => {
    const runner = new StatefulContainerRunner();
    runner.add({ id: "foreign-id", name: testCase.containerName, labels: testCase.labels, running: false });
    await state.writeCiRunner(testCase.record);

    const deletion = deleteCiRunner(runner, options, PROJECT.name, testCase.record.name);

    await expect(deletion).rejects.toThrow(/conflicts with DIM ownership/);
    expect(runner.current(testCase.containerName)?.id).toBe("foreign-id");
    expect(runner.calls.some((call) => call[1] === "container" && call[2] === "rm")).toBe(false);
    expect(giteaCiCoordinator.removeWorkflowJobWebhook).not.toHaveBeenCalled();
    expect(giteaCiCoordinator.removeRunner).not.toHaveBeenCalled();
    expect(giteaCiCoordinator.reconcileWorkflowJobWebhookTargets).not.toHaveBeenCalled();
    await expect(state.readCiRunner(PROJECT.name, testCase.record.name)).resolves.toMatchObject({ schemaVersion: 8 });
  });

  it.each(deletionCases)("fails closed on misleading absence text for a $label", async (testCase) => {
    const runner = new StatefulContainerRunner();
    runner.failNextInspect(`daemon unavailable; no such container: ${testCase.containerName}`);
    await state.writeCiRunner(testCase.record);

    const deletion = deleteCiRunner(runner, options, PROJECT.name, testCase.record.name);

    await expect(deletion).rejects.toThrow(/failed to inspect CI runner container/);
    expect(runner.calls.some((call) => call[1] === "container" && call[2] === "rm")).toBe(false);
    expect(giteaCiCoordinator.removeWorkflowJobWebhook).not.toHaveBeenCalled();
    expect(giteaCiCoordinator.removeRunner).not.toHaveBeenCalled();
    await expect(state.readCiRunner(PROJECT.name, testCase.record.name)).resolves.toMatchObject({ schemaVersion: 8 });
  });

  it.each(deletionCases)("removes the inspected $label ID without removing its replacement", async (testCase) => {
    const runner = new StatefulContainerRunner();
    runner.add({ id: "owned-id", name: testCase.containerName, labels: EXPECTED_CONTAINER_LABELS[testCase.executor], running: false });
    runner.replaceAfterNextInspect({
      id: "foreign-replacement-id",
      name: testCase.containerName,
      labels: ["dim.managed=true", "dim.owner=foreign"],
      running: false
    });
    await state.writeCiRunner(testCase.record);

    await deleteCiRunner(runner, options, PROJECT.name, testCase.record.name);

    expect(runner.calls).toContainEqual([
      "docker", "container", "inspect", testCase.containerName, "--format",
      expect.stringContaining('{{index .Config.Labels "dim.capacity"}}')
    ]);
    expect(runner.current(testCase.containerName)?.id).toBe("foreign-replacement-id");
    expect(runner.calls).toContainEqual(["docker", "container", "rm", "--force", "owned-id"]);
    expect(runner.calls).not.toContainEqual(["docker", "container", "rm", "--force", testCase.containerName]);
    await expect(state.readCiRunner(PROJECT.name, testCase.record.name)).rejects.toThrow(/not found/);
  });

  it.each(deletionCases)("tolerates exact inspected-ID absence while removing a $label", async (testCase) => {
    const runner = new StatefulContainerRunner();
    runner.add({ id: "disappearing-id", name: testCase.containerName, labels: EXPECTED_CONTAINER_LABELS[testCase.executor], running: false });
    runner.disappearAfterNextInspect();
    await state.writeCiRunner(testCase.record);

    await deleteCiRunner(runner, options, PROJECT.name, testCase.record.name);

    expect(runner.calls).toContainEqual(["docker", "container", "rm", "--force", "disappearing-id"]);
    await expect(state.readCiRunner(PROJECT.name, testCase.record.name)).rejects.toThrow(/not found/);
  });

  it.each(deletionCases)("rejects misleading removal stderr for a $label", async (testCase) => {
    const runner = new StatefulContainerRunner();
    runner.add({ id: "owned-id", name: testCase.containerName, labels: EXPECTED_CONTAINER_LABELS[testCase.executor], running: false });
    runner.failNextRemove("permission denied; No such container: owned-id");
    await state.writeCiRunner(testCase.record);

    await expect(deleteCiRunner(runner, options, PROJECT.name, testCase.record.name))
      .rejects.toThrow(/failed to remove CI runner container/);
    expect(giteaCiCoordinator.removeWorkflowJobWebhook).not.toHaveBeenCalled();
    expect(giteaCiCoordinator.removeRunner).not.toHaveBeenCalled();
    await expect(state.readCiRunner(PROJECT.name, testCase.record.name)).resolves.toEqual(testCase.record);
  });
});
