import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_CI_RUNNER_DEFAULTS,
  CI_RUNNER_LABELS,
  ciRunnerContainerArgs,
  ciRunnerContainerName,
  effectiveCiRunnerResources
} from "../src/ciRunner.js";
import { giteaCiRunnerApiBase } from "../src/giteaCiCoordinator.js";
import { LifecycleState } from "../src/lifecycleState.js";
import type { CiRunnerRecord, LifecycleOptions } from "../src/lifecycleTypes.js";

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
    expect(() => ciRunnerContainerName("../bad")).toThrow(/project name/);
  });

  it("registers the Project runner at organization scope", () => {
    expect(giteaCiRunnerApiBase({
      gitNamespace: "dim-example"
    })).toBe("/orgs/dim-example/actions/runners");
  });

  it("applies the runner boundary without mounting the host Docker socket", () => {
    const record = {
      projectName: "example",
      containerName: "dim-ci-example",
      volumeName: "dim-ci-example-data",
      image: "runner:image",
      runtime: "sysbox-runc",
      resources: { cpus: "4", memory: "8g", pidsLimit: "2048" }
    } as CiRunnerRecord;
    const args = ciRunnerContainerArgs(record, { instanceUrl: "http://coordinator", token: "secret" });
    expect(args).toContain("sysbox-runc");
    expect(args).toContain("4");
    expect(args).toContain("8g");
    expect(args).toContain("2048");
    expect(args.join(" ")).not.toContain("/var/run/docker.sock");
    expect(args.join(" ")).toContain("dim:docker://gitea/runner-images:ubuntu-24.04");
    expect(args.join(" ")).toContain("ubuntu-24.04:docker://gitea/runner-images:ubuntu-24.04");
    expect(args).toContain(`GITEA_RUNNER_LABELS=${CI_RUNNER_LABELS}`);
    expect(CI_RUNNER_LABELS).toContain("dim-container-integration:host");
  });
});

describe("CI runner state", () => {
  it("reads and lists schema 1 runner records", async () => {
    const root = await mkdtemp(join(tmpdir(), "dim-ci-runner-state-"));
    temporaryDirectories.push(root);
    const state = new LifecycleState(root);
    const record = {
      schemaVersion: 1,
      name: "example",
      projectId: "project-id",
      projectName: "example",
      provider: "gitea",
      backend: "container",
      phase: "ready",
      containerName: "dim-ci-example",
      volumeName: "dim-ci-example-data",
      image: "runner:image",
      runtime: "sysbox-runc",
      resources: { cpus: "4", memory: "8g", pidsLimit: "2048" },
      inheritsResources: true,
      labels: ["dim"],
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
      "CI runner 'example' uses unsupported state schema 3; expected 1"
    );
  });
});
