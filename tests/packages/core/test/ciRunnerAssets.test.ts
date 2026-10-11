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


it("ships a pinned, syntactically valid supervisor without putting the registration token in cloud-init", () => {
    expect(QEMU_CI_SUPERVISOR_DOCKERFILE).toMatch(/^FROM ubuntu@sha256:[0-9a-f]{64}$/m);
    expect(spawnSync("bash", ["-n"], { input: QEMU_CI_SUPERVISOR_SCRIPT }).status).toBe(0);
    expect(spawnSync("bash", ["-n"], { input: QEMU_CI_COMMON_PROVISION_SCRIPT }).status).toBe(0);
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("dim-qemu-ci-prepare-image");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("DIM_KVM_IMAGE_CACHE=/var/lib/dim-kvm-cache");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain('"TCP:$registry_cache_upstream"');
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain('"http://127.0.0.1:$registry_relay_port/v2/"');
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain('"registry-mirrors": ["http://10.0.2.2:$registry_relay_port"]');
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("DIM_CI_REGISTRY_CACHE_UPSTREAM=10.0.2.2:$registry_relay_port");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("127.0.0.1 registry-1.docker.io");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("127.0.0.1 auth.docker.io");
    expect(QEMU_CI_SUPERVISOR_SCRIPT.indexOf("127.0.0.1 registry-1.docker.io"))
      .toBeLessThan(QEMU_CI_SUPERVISOR_SCRIPT.indexOf("systemctl, restart, docker"));
    const userData = QEMU_CI_SUPERVISOR_SCRIPT.match(/cat >"\$cleanup_dir\/user-data" <<EOF\n([\s\S]*?)\nEOF/)?.[1];
    expect(userData).toBeDefined();
    expect(userData).not.toContain("GITEA_RUNNER_REGISTRATION_TOKEN");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("--ephemeral");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).not.toContain("printf '%s\\n' \"$GITEA_RUNNER_REGISTRATION_TOKEN\" | ssh");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("DIM_QEMU_CI_LABELS");
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain('dispatch_labels = frozenset(os.environ["DIM_QEMU_CI_LABELS"].split(","))');
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain('selected = not dispatch_labels.isdisjoint(workflow_job.get("labels", []))');
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain('action in ("queued", "in_progress", "completed")');
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain('"/var/lib/dim-qemu-ci-dispatch/demand.json"');
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain("fcntl.flock(lock, fcntl.LOCK_EX)");
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain("except subprocess.CalledProcessError as error:");
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain("queued demand remains; retrying");
  });

it("ships a pinned minimal Sysbox runner host image with its required Docker CLI", () => {
    expect(SYSBOX_CI_RUNNER_BASE_IMAGE).toMatch(/^gitea\/act_runner@sha256:[0-9a-f]{64}$/);
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain(`FROM ${SYSBOX_CI_RUNNER_BASE_IMAGE}`);
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("command -v act_runner");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("command -v dockerd");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("rm -f /usr/bin/git");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).not.toMatch(/rm -f[^\n]*\/usr\/local\/bin\/docker/);
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("! command -v node");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("! command -v git");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).toContain("&& command -v docker");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).not.toMatch(/\b(?:just|jq|socat|script)\b/);
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).not.toContain("util-linux-misc");
    expect(SYSBOX_CI_RUNNER_DOCKERFILE).not.toContain("dim-ci-runner-health");
  });

it("uses a fresh cache alias for the corrected Sysbox runner image", () => {
    expect(SYSBOX_CI_RUNNER_IMAGE).toBe("dev-infra-manager-ci-runner:act-runner-minimal-v2");
  });
});
