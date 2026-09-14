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


it("derives stable managed resource names", () => {
    expect(ciRunnerContainerName("example", "fast-1")).toMatch(/^dim-ci-example-fast-1-[0-9a-f]{16}$/);
    expect(ciRunnerQemuSupervisorName("example", "kvm-1")).toMatch(/^dim-ci-example-kvm-1-qemu-supervisor-[0-9a-f]{16}$/);
    expect(ciRunnerQemuRunnerName("example", "kvm-1")).toMatch(/^dim-ci-example-kvm-1-qemu-[0-9a-f]{16}$/);
    expect(ciRunnerQemuDispatchVolumeName("example")).toMatch(/^dim-ci-example-qemu-dispatch-[0-9a-f]{16}$/);
    expect(ciRunnerQemuProjectCacheVolumeName("example")).toMatch(/^dim-ci-example-qemu-cache-[0-9a-f]{16}$/);
    expect(ciRunnerQemuVolumeName("example", "kvm-1")).toMatch(/^dim-ci-example-kvm-1-qemu-data-[0-9a-f]{16}$/);
    expect(() => ciRunnerContainerName("../bad", "fast-1")).toThrow(/project name/);
    expect(() => ciRunnerContainerName("example", "../bad")).toThrow(/CI runner name/);
  });

it("registers the Project runner at organization scope", () => {
    expect(giteaCiRunnerApiBase({
      gitNamespace: "dim-example"
    })).toBe("/orgs/dim-example/actions/runners");
  });

it("applies the runner boundary without mounting the host Docker socket", () => {
    const record = { projectName: "example", projectId: "project-id", name: "fast-1" };
    const executor = {
      kind: "sysbox" as const, phase: "ready" as const,
      containerName: "dim-ci-example",
      volumeName: "dim-ci-example-data",
      image: `sha256:${"e".repeat(64)}`,
      runtime: "sysbox-runc",
      resources: { cpus: "4", memory: "8g", pidsLimit: "2048" },
      inheritsResources: true, labels: ["dim"], updatedAt: "now"
    };
    const args = ciRunnerContainerArgs({
      record,
      executor,
      labels: runnerLabels,
      registration: { instanceUrl: "http://coordinator", token: "secret" },
      registryMirror: true
    });
    expect(args).toContain("sysbox-runc");
    expect(args).toContain("4");
    expect(args).toContain("8g");
    expect(args).toContain("2048");
    expect(args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(args.join(" ")).toContain("target=/etc/docker/daemon.json,volume-subpath=docker-daemon.json,readonly");
    expect(args).toEqual(expect.arrayContaining([
      "--add-host=registry-1.docker.io:127.0.0.1",
      "--add-host=auth.docker.io:127.0.0.1",
      "dim.managed=true",
      "dim.owner=dim",
      "dim.project=example",
      "dim.project-id=project-id",
      "dim.capacity=fast-1",
      "dim.executor=sysbox",
      "dim.resource=ci-runner",
      "dim.kind=container"
    ]));
    expect(args.find((argument) => argument.startsWith("dim.digest="))).toMatch(/^dim\.digest=[0-9a-f]{64}$/);
    expect(args).toContain(`GITEA_RUNNER_LABELS=${runnerLabels}`);
    expect(runnerLabels).not.toContain("dim-container-integration");
    expect(runnerLabels).not.toContain(":host");
    expect(runnerLabels).not.toContain("dim-qemu");
  });

it("keeps KVM out of the Sysbox runner and configures a trusted QEMU supervisor", async () => {
    await expect(detectCiRunnerKvm(async () => {})).resolves.toBe(true);
    await expect(detectCiRunnerKvm(async () => { throw new Error("missing"); })).resolves.toBe(false);
    await expect(detectCiRunnerKvm(async () => {}, "arm64")).resolves.toBe(false);
    const record = { projectName: "example", projectId: "project-id", name: "kvm-1" };
    const sysbox = { kind: "sysbox" as const, phase: "ready" as const, containerName: "dim-ci-example", volumeName: "dim-ci-example-data", image: `sha256:${"e".repeat(64)}`, runtime: "sysbox-runc", resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }, inheritsResources: true, labels: ["dim"], updatedAt: "now" };
    const containerArgs = ciRunnerContainerArgs({ record, executor: sysbox, labels: runnerLabels, registryMirror: true });
    expect(containerArgs).not.toContain("/dev/kvm");
    expect(containerArgs).toContain(`GITEA_RUNNER_LABELS=${runnerLabels}`);
    expect(containerArgs).toContain("DIM_CI_REGISTRY_CACHE_UPSTREAM=dim-registry-cache:5000");

  });
});
