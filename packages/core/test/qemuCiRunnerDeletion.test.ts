import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteCiRunner } from "../../../../core/packages/core/src/ciRunner.js";
import { ciRunnerVolumeLabels, type CiRunnerVolumePlan } from "../../../../core/packages/core/src/ciRunnerVolume.js";
import { giteaCiCoordinator } from "../../../../core/packages/core/src/giteaCiCoordinator.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CiRunnerRecord, LifecycleOptions, ProjectRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import {
  ciRunnerQemuDispatchVolumeName,
  ciRunnerQemuProjectCacheVolumeName,
  ciRunnerQemuVolumeName
} from "../../../../core/packages/core/src/qemuCiRunnerLifecycle.js";
import { ciRunnerQemuCommonCacheVolumeName } from "../../../../core/packages/core/src/qemuCiRunnerImage.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

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
  createdAt: "now",
  updatedAt: "now"
} satisfies ProjectRecord;

function qemuRecord(name: string): CiRunnerRecord {
  return {
    schemaVersion: 8,
    name,
    projectId: PROJECT.id,
    projectName: PROJECT.name,
    provider: "gitea-actions",
    config: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64) },
    executor: {
      kind: "qemu",
      phase: "ready",
      supervisorName: `supervisor-${name}`,
      volumeName: ciRunnerQemuVolumeName(PROJECT.name, name),
      image: `sha256:${"e".repeat(64)}`,
      projectHook: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), kind: "absent", digest: "c".repeat(64) },
      resources: { cpus: "4", memory: "8g" },
      inheritsResources: true,
      labels: ["dim-container-integration", "dim-qemu"],
      jobImage: `gitea/runner-images@sha256:${"d".repeat(64)}`,
      updatedAt: "now"
    },
    createdAt: "now",
    updatedAt: "now"
  };
}

class DeletionRunner implements StreamingCommandRunner {
  readonly calls: string[][] = [];
  readonly volumes = new Map<string, readonly string[]>();
  failRemovalOnce?: string;

  add(plan: CiRunnerVolumePlan): void {
    this.volumes.set(plan.name, ciRunnerVolumeLabels(plan));
  }

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push([command, ...args]);
    if (args[0] === "container" && args[1] === "inspect") {
      return result(command, args, 1, "", `Error response from daemon: No such container: ${args[2] ?? ""}`);
    }
    if (args[0] === "container" && args[1] === "rm") return result(command, args);
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args[2] ?? "";
      const labels = this.volumes.get(name);
      return labels === undefined
        ? result(command, args, 1, "", "No such volume")
        : result(command, args, 0, labels.map((label) => label.slice(label.indexOf("=") + 1)).join("|") + "\n");
    }
    if (args[0] === "volume" && args[1] === "rm") {
      const name = args[2] ?? "";
      if (this.failRemovalOnce === name) {
        delete this.failRemovalOnce;
        return result(command, args, 1, "", "busy");
      }
      if (!this.volumes.delete(name)) return result(command, args, 1, "", "No such volume");
      return result(command, args);
    }
    return result(command, args);
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

function result(command: string, args: string[], exitCode = 0, stdout = "", stderr = ""): CommandResult {
  return { command, args, exitCode, stdout, stderr };
}

function plan(name: string, resource: CiRunnerVolumePlan["resource"]): CiRunnerVolumePlan {
  return { name, resource, project: PROJECT.name, projectId: PROJECT.id };
}

describe("QEMU CI capacity deletion", () => {
  let root = "";
  let state: LifecycleState;
  let options: LifecycleOptions;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dim-qemu-delete-"));
    state = new LifecycleState(root);
    options = { stateRoot: root } as LifecycleOptions;
    await state.claimProject(PROJECT);
    vi.spyOn(giteaCiCoordinator, "removeWorkflowJobWebhook").mockResolvedValue();
    vi.spyOn(giteaCiCoordinator, "removeRunner").mockResolvedValue();
    vi.spyOn(giteaCiCoordinator, "reconcileWorkflowJobWebhookTargets").mockResolvedValue();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("retains state when an external deletion command fails", async () => {
    const runner = new DeletionRunner();
    const record = qemuRecord("kvm-1");
    await state.writeCiRunner(record);
    runner.add(plan(record.executor.kind === "qemu" ? record.executor.volumeName : "", "ci-qemu-data"));
    runner.failRemovalOnce = ciRunnerQemuVolumeName(PROJECT.name, record.name);

    const deletion = deleteCiRunner(runner, options, PROJECT.name, record.name);

    await expect(deletion).rejects.toThrow(/failed to remove/);
    await expect(state.readCiRunner(PROJECT.name, record.name)).resolves.toMatchObject({ name: record.name });
  });

  it("retries safely after some external volumes were already removed", async () => {
    const runner = new DeletionRunner();
    const record = qemuRecord("kvm-1");
    await state.writeCiRunner(record);
    runner.add(plan(record.executor.kind === "qemu" ? record.executor.volumeName : "", "ci-qemu-data"));
    runner.add(plan(ciRunnerQemuDispatchVolumeName(PROJECT.name), "ci-qemu-dispatch"));
    runner.add(plan(ciRunnerQemuProjectCacheVolumeName(PROJECT.name), "ci-qemu-project-cache"));
    runner.failRemovalOnce = ciRunnerQemuDispatchVolumeName(PROJECT.name);

    await expect(deleteCiRunner(runner, options, PROJECT.name, record.name)).rejects.toThrow(/failed to remove/);
    await deleteCiRunner(runner, options, PROJECT.name, record.name);

    await expect(state.readCiRunner(PROJECT.name, record.name)).rejects.toThrow(/not found/);
    expect(runner.volumes.size).toBe(0);
  });

  it("retains shared Project resources while another capacity remains", async () => {
    const runner = new DeletionRunner();
    const first = qemuRecord("kvm-1");
    const second = qemuRecord("kvm-2");
    await state.writeCiRunner(first);
    await state.writeCiRunner(second);
    runner.add(plan(ciRunnerQemuVolumeName(PROJECT.name, first.name), "ci-qemu-data"));
    runner.add(plan(ciRunnerQemuDispatchVolumeName(PROJECT.name), "ci-qemu-dispatch"));
    runner.add(plan(ciRunnerQemuProjectCacheVolumeName(PROJECT.name), "ci-qemu-project-cache"));

    await deleteCiRunner(runner, options, PROJECT.name, first.name);

    expect(runner.volumes.has(ciRunnerQemuVolumeName(PROJECT.name, first.name))).toBe(false);
    expect(runner.volumes.has(ciRunnerQemuDispatchVolumeName(PROJECT.name))).toBe(true);
    expect(runner.volumes.has(ciRunnerQemuProjectCacheVolumeName(PROJECT.name))).toBe(true);
    await expect(state.readCiRunner(PROJECT.name, second.name)).resolves.toMatchObject({ name: second.name });
  });

  it("removes final Project resources and state but preserves the common cache", async () => {
    const runner = new DeletionRunner();
    const record = qemuRecord("kvm-1");
    await state.writeCiRunner(record);
    runner.add(plan(ciRunnerQemuVolumeName(PROJECT.name, record.name), "ci-qemu-data"));
    runner.add(plan(ciRunnerQemuDispatchVolumeName(PROJECT.name), "ci-qemu-dispatch"));
    runner.add(plan(ciRunnerQemuProjectCacheVolumeName(PROJECT.name), "ci-qemu-project-cache"));
    runner.add({ name: ciRunnerQemuCommonCacheVolumeName(), resource: "ci-qemu-common-cache" });
    const projectImageState = join(root, "assets", "qemu-ci-projects", PROJECT.id);
    await mkdir(projectImageState, { recursive: true });
    await writeFile(join(projectImageState, "manifest.json"), "{}\n");

    await deleteCiRunner(runner, options, PROJECT.name, record.name);

    expect([...runner.volumes.keys()]).toEqual([ciRunnerQemuCommonCacheVolumeName()]);
    await expect(state.readCiRunner(PROJECT.name, record.name)).rejects.toThrow(/not found/);
    await expect(access(projectImageState)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
