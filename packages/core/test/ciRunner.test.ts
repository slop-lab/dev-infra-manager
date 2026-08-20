import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_CI_RUNNER_DEFAULTS,
  CI_RUNNER_LABELS,
  ciRunnerContainerArgs,
  ciRunnerContainerName,
  ciRunnerQemuRunnerName,
  ciRunnerQemuSupervisorArgs,
  ciRunnerQemuSupervisorName,
  ciRunnerQemuVolumeName,
  detectCiRunnerKvm,
  effectiveCiRunnerResources
} from "../src/ciRunner.js";
import { giteaCiRunnerApiBase } from "../src/giteaCiCoordinator.js";
import { LifecycleState } from "../src/lifecycleState.js";
import type { CiRunnerRecord, LifecycleOptions } from "../src/lifecycleTypes.js";
import {
  QEMU_CI_SUPERVISOR_DOCKERFILE,
  QEMU_CI_SUPERVISOR_SCRIPT,
  QEMU_CI_WEBHOOK_SCRIPT
} from "../src/qemuCiRunnerAssets.js";

const options = {
  ciRunnerDefaultCpus: BUILTIN_CI_RUNNER_DEFAULTS.cpus,
  ciRunnerDefaultMemory: BUILTIN_CI_RUNNER_DEFAULTS.memory,
  ciRunnerDefaultPidsLimit: BUILTIN_CI_RUNNER_DEFAULTS.pidsLimit
} as LifecycleOptions;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CI runner resources", () => {
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

  it("derives stable managed resource names", () => {
    expect(ciRunnerContainerName("example")).toBe("dim-ci-example");
    expect(ciRunnerQemuSupervisorName("example")).toBe("dim-ci-example-qemu-supervisor");
    expect(ciRunnerQemuRunnerName("example")).toBe("dim-ci-example-qemu");
    expect(ciRunnerQemuVolumeName("example")).toBe("dim-ci-example-qemu-data");
    expect(() => ciRunnerContainerName("../bad")).toThrow(/project name/);
  });

  it("registers the Project runner at organization scope", () => {
    expect(giteaCiRunnerApiBase({
      gitNamespace: "dim-example"
    })).toBe("/orgs/dim-example/actions/runners");
  });

  it("applies the runner boundary without mounting the host Docker socket", () => {
    const record = { projectName: "example" };
    const executor = {
      kind: "sysbox" as const, phase: "ready" as const,
      containerName: "dim-ci-example",
      volumeName: "dim-ci-example-data",
      image: "runner:image",
      runtime: "sysbox-runc",
      resources: { cpus: "4", memory: "8g", pidsLimit: "2048" },
      inheritsResources: true, labels: ["dim"], updatedAt: "now"
    };
    const args = ciRunnerContainerArgs(record, executor, { instanceUrl: "http://coordinator", token: "secret" });
    expect(args).toContain("sysbox-runc");
    expect(args).toContain("4");
    expect(args).toContain("8g");
    expect(args).toContain("2048");
    expect(args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(args.join(" ")).toContain("dim:docker://gitea/runner-images:ubuntu-24.04");
    expect(args.join(" ")).toContain("ubuntu-24.04:docker://gitea/runner-images:ubuntu-24.04");
    expect(args).toContain(`GITEA_RUNNER_LABELS=${CI_RUNNER_LABELS}`);
    expect(CI_RUNNER_LABELS).toContain("dim-container-integration:host");
    expect(CI_RUNNER_LABELS).not.toContain("dim-qemu");
  });

  it("keeps KVM out of the Sysbox runner and configures a trusted QEMU supervisor", async () => {
    await expect(detectCiRunnerKvm(async () => {})).resolves.toBe(true);
    await expect(detectCiRunnerKvm(async () => { throw new Error("missing"); })).resolves.toBe(false);
    await expect(detectCiRunnerKvm(async () => {}, "arm64")).resolves.toBe(false);
    const record = { projectName: "example" };
    const sysbox = { kind: "sysbox" as const, phase: "ready" as const, containerName: "dim-ci-example", volumeName: "dim-ci-example-data", image: "runner:image", runtime: "sysbox-runc", resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }, inheritsResources: true, labels: ["dim"], updatedAt: "now" };
    const qemu = { kind: "qemu" as const, phase: "ready" as const, supervisorName: "dim-ci-example-qemu-supervisor", volumeName: "dim-ci-example-qemu-data", image: "qemu-supervisor:image", labels: ["dim-qemu"], updatedAt: "now" };
    const containerArgs = ciRunnerContainerArgs(record, sysbox);
    expect(containerArgs).not.toContain("/dev/kvm");
    expect(containerArgs).toContain(`GITEA_RUNNER_LABELS=${CI_RUNNER_LABELS}`);

    const qemuArgs = ciRunnerQemuSupervisorArgs(
      record,
      qemu,
      { instanceUrl: "http://coordinator", token: "secret" },
      "Bearer webhook-secret",
      () => 108
    );
    expect(qemuArgs).toEqual(expect.arrayContaining([
      "--runtime", "runc", "--device", "/dev/kvm", "--group-add", "108"
    ]));
    expect(qemuArgs).toContain("GITEA_RUNNER_NAME=dim-ci-example-qemu");
    expect(qemuArgs).toContain("DIM_QEMU_WEBHOOK_AUTHORIZATION=Bearer webhook-secret");
    expect(qemuArgs).toEqual(expect.arrayContaining(["--memory", "14g"]));
    expect(qemuArgs).toContain("qemu-supervisor:image");
  });

  it("ships a pinned, syntactically valid supervisor without putting the registration token in cloud-init", () => {
    expect(QEMU_CI_SUPERVISOR_DOCKERFILE).toMatch(/^FROM ubuntu@sha256:[0-9a-f]{64}$/m);
    expect(spawnSync("bash", ["-n"], { input: QEMU_CI_SUPERVISOR_SCRIPT }).status).toBe(0);
    const userData = QEMU_CI_SUPERVISOR_SCRIPT.match(/cat >"\$cleanup_dir\/user-data" <<EOF\n([\s\S]*?)\nEOF/)?.[1];
    expect(userData).toBeDefined();
    expect(userData).not.toContain("GITEA_RUNNER_REGISTRATION_TOKEN");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("--ephemeral");
    expect(QEMU_CI_SUPERVISOR_SCRIPT).toContain("printf '%s\\n' \"$GITEA_RUNNER_REGISTRATION_TOKEN\" | ssh");
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain('selected = "dim-qemu" in workflow_job.get("labels", [])');
    expect(QEMU_CI_WEBHOOK_SCRIPT).toContain('payload.get("action") == "queued"');
  });
});

describe("CI runner state", () => {
  it("reads and lists schema 2 executor records", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-state-"));
    temporaryDirectories.push(root);
    const state = new LifecycleState(root);
    const record = {
      schemaVersion: 2,
      name: "example",
      projectId: "project-id",
      projectName: "example",
      provider: "gitea",
      executors: { sysbox: { kind: "sysbox", phase: "ready", containerName: "dim-ci-example", volumeName: "dim-ci-example-data", image: "runner:image", runtime: "sysbox-runc", resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }, inheritsResources: true, labels: ["dim"], updatedAt: "2026-08-18T00:00:00.000Z" } },
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z"
    } satisfies CiRunnerRecord;

    await state.writeCiRunner(record);

    await expect(state.readCiRunner("example")).resolves.toEqual(record);
    await expect(state.listCiRunners()).resolves.toEqual([record]);
  });

  it("rejects a runner record with a different schema version", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-state-invalid-"));
    temporaryDirectories.push(root);
    const directory = join(root, "ci-runners");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "example.json"), JSON.stringify({ schemaVersion: 3, name: "example" }));

    await expect(new LifecycleState(root).listCiRunners()).rejects.toThrow(
      "CI runner 'example' uses unsupported state schema 3; expected 2"
    );
  });
});
