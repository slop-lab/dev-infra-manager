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
  enableCiRunner,
  effectiveCiRunnerResources
} from "../src/ciRunner.js";
import { giteaCiRunnerApiBase } from "../src/giteaCiCoordinator.js";
import { LifecycleState } from "../src/lifecycleState.js";
import type { CiRunnerRecord, LifecycleOptions, ProjectRecord } from "../src/lifecycleTypes.js";
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
    expect(ciRunnerContainerName("example", "fast-1")).toBe("dim-ci-example-fast-1");
    expect(ciRunnerQemuSupervisorName("example", "kvm-1")).toBe("dim-ci-example-kvm-1-qemu-supervisor");
    expect(ciRunnerQemuRunnerName("example", "kvm-1")).toBe("dim-ci-example-kvm-1-qemu");
    expect(ciRunnerQemuVolumeName("example", "kvm-1")).toBe("dim-ci-example-kvm-1-qemu-data");
    expect(() => ciRunnerContainerName("../bad", "fast-1")).toThrow(/project name/);
    expect(() => ciRunnerContainerName("example", "../bad")).toThrow(/CI runner name/);
  });

  it("registers the Project runner at organization scope", () => {
    expect(giteaCiRunnerApiBase({
      gitNamespace: "dim-example"
    })).toBe("/orgs/dim-example/actions/runners");
  });

  it("applies the runner boundary without mounting the host Docker socket", () => {
    const record = { projectName: "example", name: "fast-1" };
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
    const record = { projectName: "example", name: "kvm-1" };
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
    expect(qemuArgs).toContain("GITEA_RUNNER_NAME=dim-ci-example-kvm-1-qemu");
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
  it("reads and lists independently named schema 3 runners", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-state-"));
    temporaryDirectories.push(root);
    const state = new LifecycleState(root);
    const record = {
      schemaVersion: 3,
      name: "fast-1",
      projectId: "project-id",
      projectName: "example",
      provider: "gitea",
      executor: { kind: "sysbox", phase: "ready", containerName: "dim-ci-example-fast-1", volumeName: "dim-ci-example-fast-1-data", image: "runner:image", runtime: "sysbox-runc", resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }, inheritsResources: true, labels: ["dim"], updatedAt: "2026-08-18T00:00:00.000Z" },
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

  it("rejects a runner record with a different schema version", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-state-invalid-"));
    temporaryDirectories.push(root);
    const directory = join(root, "ci-runners", "example");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "fast-1.json"), JSON.stringify({ schemaVersion: 2, name: "fast-1" }));

    await expect(new LifecycleState(root).listCiRunners()).rejects.toThrow(
      "CI runner 'fast-1' uses unsupported state schema 2; expected 3"
    );
  });

  it("allows only one QEMU runner per Project until scheduling is centralized", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-qemu-capacity-"));
    temporaryDirectories.push(root);
    const state = new LifecycleState(root);
    const now = "2026-08-21T00:00:00.000Z";
    await state.claimProject({
      schemaVersion: 3,
      id: "project-id",
      name: "example",
      gitNamespace: "dim-example",
      phase: "ready",
      rootRepositoryAlias: "root",
      rootRef: "refs/heads/main",
      repositories: [],
      createdAt: now,
      updatedAt: now
    } satisfies ProjectRecord);
    await state.writeCiRunner({
      schemaVersion: 3,
      name: "release-1",
      projectId: "project-id",
      projectName: "example",
      provider: "gitea-actions",
      executor: {
        kind: "qemu",
        phase: "ready",
        supervisorName: "dim-ci-example-release-1-qemu-supervisor",
        volumeName: "dim-ci-example-release-1-qemu-data",
        image: "qemu-supervisor:image",
        labels: ["dim-qemu"],
        updatedAt: now
      },
      createdAt: now,
      updatedAt: now
    });
    const runner = {
      async run(command: string, args: string[]) {
        return { command, args, stdout: "", stderr: "", exitCode: 0 };
      },
      async runStreaming() { return 0; }
    };

    await expect(enableCiRunner(runner, { ...options, stateRoot: root }, {
      project: "example",
      name: "release-2",
      executor: "qemu"
    })).rejects.toThrow(/already has QEMU CI runner 'release-1'/);
  });
});
