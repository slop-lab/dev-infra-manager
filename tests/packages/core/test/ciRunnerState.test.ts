import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { BUILTIN_CI_RUNNER_DEFAULTS, ciRunnerContainerArgs, ciRunnerContainerName, ciRunnerQemuDispatchVolumeName, ciRunnerQemuRunnerName, ciRunnerQemuSupervisorName, ciRunnerQemuVolumeName, detectCiRunnerKvm, effectiveCiRunnerResources, effectiveQemuCiRunnerResources, qemuMemoryMiB } from "../../../../core/packages/core/src/ciRunner.js";
import { ciRunnerQemuProjectCacheVolumeName } from "../../../../core/packages/core/src/qemuCiRunnerLifecycle.js";
import { giteaCiRunnerApiBase } from "../../../../core/packages/core/src/giteaCiCoordinator.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CiRunnerRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { QEMU_CI_COMMON_PROVISION_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerImageAssets.js";
import { QEMU_CI_SUPERVISOR_DOCKERFILE, QEMU_CI_SUPERVISOR_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerSupervisorAssets.js";
import { QEMU_CI_WEBHOOK_SCRIPT } from "../../../../core/packages/core/src/qemuCiRunnerWebhookAsset.js";
import { SYSBOX_CI_RUNNER_BASE_IMAGE, SYSBOX_CI_RUNNER_DOCKERFILE, SYSBOX_CI_RUNNER_IMAGE } from "../../../../core/packages/core/src/sysboxCiRunnerAssets.js";
import { availablePort, hasPython, options, readFileIfPresent, runnerLabels, sendWorkflowJob, temporaryDirectories, waitFor } from "./ciRunnerFixture.js";

describe("CI runner state", () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });
it("reads and lists independently named schema 8 runners with config provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-state-"));
    temporaryDirectories.push(root);
    const state = new LifecycleState(root);
    const record = {
      schemaVersion: 8,
      name: "fast-1",
      projectId: "project-id",
      projectName: "example",
      provider: "gitea",
      config: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64) },
      executor: { kind: "sysbox", phase: "ready", containerName: "dim-ci-example-fast-1", volumeName: "dim-ci-example-fast-1-data", image: `sha256:${"e".repeat(64)}`, runtime: "sysbox-runc", resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }, inheritsResources: true, labels: ["dim"], updatedAt: "2026-08-18T00:00:00.000Z" },
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z"
    } satisfies CiRunnerRecord;
    const second = {
      ...record,
      name: "fast-2",
      executor: {
        ...record.executor,
        containerName: "dim-ci-example-fast-2",
        volumeName: "dim-ci-example-fast-2-data"
      }
    } satisfies CiRunnerRecord;

    await state.writeCiRunner(record);
    await state.writeCiRunner(second);

    await expect(state.readCiRunner("example", "fast-1")).resolves.toEqual(record);
    await expect(state.readCiRunner("example", "fast-2")).resolves.toEqual(second);
    await expect(state.listCiRunners()).resolves.toEqual([record, second]);
  });

it("removes the Project state directory only after its last runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-remove-"));
    temporaryDirectories.push(root);
    const state = new LifecycleState(root);
    const record = {
      schemaVersion: 8,
      name: "primary",
      projectId: "project-id",
      projectName: "example",
      provider: "gitea-actions",
      config: { sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64) },
      executor: { kind: "sysbox", phase: "ready", containerName: "primary", volumeName: "primary-data", image: `sha256:${"e".repeat(64)}`, runtime: "sysbox-runc", resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }, inheritsResources: true, labels: ["dim"], updatedAt: "now" },
      createdAt: "now",
      updatedAt: "now"
    } satisfies CiRunnerRecord;
    await state.writeCiRunner(record);
    await state.writeCiRunner({
      ...record,
      name: "secondary",
      executor: { ...record.executor, containerName: "secondary", volumeName: "secondary-data" }
    });

    await expect(state.removeCiRunner("example", "primary")).resolves.toBeUndefined();
    await expect(state.listCiRunners()).resolves.toEqual([expect.objectContaining({ name: "secondary" })]);
    await expect(stat(join(root, "ci-runners", "example"))).resolves.toBeDefined();

    await expect(state.removeCiRunner("example", "secondary")).resolves.toBeUndefined();
    await expect(state.listCiRunners()).resolves.toEqual([]);
    await expect(stat(join(root, "ci-runners", "example"))).rejects.toMatchObject({ code: "ENOENT" });
  });

it("rejects a runner record with a different schema version", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-state-invalid-"));
    temporaryDirectories.push(root);
    const directory = join(root, "ci-runners", "example");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "fast-1.json"), JSON.stringify({ schemaVersion: 7, name: "fast-1" }));

    await expect(new LifecycleState(root).listCiRunners()).rejects.toThrow(
      "CI runner 'fast-1' uses unsupported state schema 7; expected 8"
    );
  });
});
