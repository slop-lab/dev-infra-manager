import {
  ciRunnerContainerLabels,
  ciRunnerContainerPlan
} from "../../../../core/packages/core/src/ciRunnerContainer.js";
import type {
  CiRunnerRecord,
  LifecycleOptions,
  ProjectRecord,
  QemuCiRunnerExecutor,
  SysboxCiRunnerExecutor
} from "../../../../core/packages/core/src/lifecycleTypes.js";
import { CONTAINER_LABEL_KEYS, type ContainerFixture } from "./ciRunnerContainerRunner.js";

export const EXPECTED_CONTAINER_LABELS = {
  sysbox: [
    "dim.managed=true", "dim.owner=dim", "dim.project=example", "dim.project-id=project-id",
    "dim.capacity=sysbox-capacity", "dim.executor=sysbox", "dim.resource=ci-runner", "dim.kind=container",
    "dim.digest=4bb6b4d18fff2eda3bebb48edb89abf2472dadff19690925659c251fda0fb192"
  ],
  qemu: [
    "dim.managed=true", "dim.owner=dim", "dim.project=example", "dim.project-id=project-id",
    "dim.capacity=qemu-capacity", "dim.executor=qemu", "dim.resource=ci-qemu-supervisor", "dim.kind=container",
    "dim.digest=aff02a8803b91c093d6ad4420f57b668f16add66cac0bbcf3e650cdacf535f98"
  ]
} as const;

export const TEST_PROJECT = {
  schemaVersion: 4,
  id: "project-id",
  name: "example",
  gitNamespace: "dim-example",
  giteaOrganizationId: 41,
  phase: "ready",
  rootRepositoryAlias: "root",
  rootRef: "main",
  repositories: [],
  createdAt: "now",
  updatedAt: "now"
} satisfies ProjectRecord;

export const STOPPED_SYSBOX_RECORD = {
  schemaVersion: 8,
  name: "sysbox-capacity",
  projectId: TEST_PROJECT.id,
  projectName: TEST_PROJECT.name,
  provider: "gitea-actions",
  config: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64) },
  executor: {
    kind: "sysbox",
    phase: "stopped",
    containerName: "shared-sysbox-name",
    volumeName: "sysbox-data",
    image: `sha256:${"c".repeat(64)}`,
    runtime: "sysbox-runc",
    resources: { cpus: "4", memory: "8g", pidsLimit: "2048" },
    inheritsResources: true,
    labels: ["dim"],
    updatedAt: "now"
  },
  createdAt: "now",
  updatedAt: "now"
} satisfies CiRunnerRecord;

export const READY_QEMU_RECORD = {
  schemaVersion: 8,
  name: "qemu-capacity",
  projectId: TEST_PROJECT.id,
  projectName: TEST_PROJECT.name,
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
  createdAt: "now",
  updatedAt: "now"
} satisfies CiRunnerRecord;

export function ownedLabels(
  record: Pick<CiRunnerRecord, "projectName" | "projectId" | "name">,
  executor: SysboxCiRunnerExecutor | QemuCiRunnerExecutor
): readonly string[] {
  return ciRunnerContainerLabels(ciRunnerContainerPlan(record, executor));
}

export function ownedContainer(record: CiRunnerRecord, id: string, running: boolean): ContainerFixture {
  const name = record.executor.kind === "sysbox" ? record.executor.containerName : record.executor.supervisorName;
  return { id, name, labels: EXPECTED_CONTAINER_LABELS[record.executor.kind], running };
}

export function containerLabelMismatchCases(labels: readonly string[]): readonly {
  readonly field: string;
  readonly labels: readonly string[];
}[] {
  return CONTAINER_LABEL_KEYS.map((key, index) => ({
    field: key,
    labels: labels.map((label, labelIndex) => labelIndex === index ? `${key}=foreign-${index}` : label)
  }));
}

export function lifecycleOptions(stateRoot: string): LifecycleOptions {
  return {
    stateRoot,
    giteaConnection: { kind: "managed" },
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
}
