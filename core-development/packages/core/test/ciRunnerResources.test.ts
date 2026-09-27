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

describe("CI runner resources", () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });


it("uses configured defaults and marks them inherited", () => {
    expect(effectiveCiRunnerResources(options, undefined, {
      cpus: "6",
      memory: "12GiB",
      pidsLimit: "4096"
    })).toEqual({
      resources: { cpus: "6", memory: "12GiB", pidsLimit: "4096" },
      inheritsResources: true
    });
  });

it("applies project overrides without changing unspecified defaults", () => {
    expect(effectiveCiRunnerResources(options, { memory: "16GiB" }, {
      cpus: "6",
      memory: "12GiB",
      pidsLimit: "4096"
    })).toEqual({
      resources: { cpus: "6", memory: "16GiB", pidsLimit: "4096" },
      inheritsResources: false
    });
  });

it("maps CPU and memory overrides to QEMU guest resources", () => {
    expect(effectiveQemuCiRunnerResources(options, { cpus: "6", memory: "12GiB" }, {
      cpus: "4", memory: "8g", pidsLimit: "2048"
    })).toEqual({
      resources: { cpus: "6", memory: "12GiB" },
      inheritsResources: false
    });
    expect(qemuMemoryMiB("12GiB")).toBe(12288);
    expect(() => effectiveQemuCiRunnerResources(options, { cpus: "1.5" })).toThrow(/positive integer/);
    expect(() => effectiveQemuCiRunnerResources(options, { pidsLimit: "512" })).toThrow(/sysbox/);
  });
});
