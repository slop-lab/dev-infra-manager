import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UserError } from "../../../../core/packages/core/src/errors.js";
import { SYSBOX_CI_REGISTRATION_HELPER_IMAGE, SYSBOX_CI_RUNNER_IMAGE } from "../../../../core/packages/core/src/sysboxCiRunnerAssets.js";
import {
  buildSysboxRunnerImage,
  ciRunnerContainerArgs,
  removeSysboxRegistration,
  resolveSysboxRunnerImage,
  sysboxRegistrationExists
} from "../../../../core/packages/core/src/sysboxCiRunnerLifecycle.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const PINNED_IMAGE = `registry.example/ci/runner@sha256:${"b".repeat(64)}`;
const stateRoots: string[] = [];

afterEach(async () => {
  await Promise.all(stateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class SysboxRunner implements StreamingCommandRunner {
  readonly calls: { readonly command: string; readonly args: readonly string[] }[] = [];

  constructor(private readonly exitCode = 0) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const iidfileIndex = args.indexOf("--iidfile");
    const iidfile = iidfileIndex < 0 ? undefined : args[iidfileIndex + 1];
    if (this.exitCode === 0 && iidfile !== undefined) await writeFile(iidfile, `${IMAGE_ID}\n`);
    return { command, args, stdout: "", stderr: this.exitCode === 0 ? "" : "daemon unavailable", exitCode: this.exitCode };
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

class ResolutionRunner implements StreamingCommandRunner {
  readonly calls: { readonly command: string; readonly args: readonly string[] }[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: readonly CommandResult[]) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    const response = this.responses[this.responseIndex];
    this.responseIndex += 1;
    if (response === undefined) throw new Error("unexpected Docker command");
    return { ...response, command, args };
  }

  async runStreaming(): Promise<number> {
    return 0;
  }
}

function commandResult(exitCode: number, stdout = "", stderr = ""): CommandResult {
  return { command: "docker", args: [], stdout, stderr, exitCode };
}

describe("Sysbox CI runner image lifecycle", () => {
  it("pulls a pinned registry reference and returns only Docker's inspected image ID", async () => {
    const runner = new ResolutionRunner([
      commandResult(0),
      commandResult(0, `${IMAGE_ID}\n`)
    ]);

    const resolved = await resolveSysboxRunnerImage(runner, "/state", PINNED_IMAGE);
    const launchArgs = ciRunnerContainerArgs({
      record: { projectName: "example", projectId: "project-id", name: "primary" },
      executor: {
        kind: "sysbox", phase: "ready", containerName: "dim-ci-example-primary",
        volumeName: "dim-ci-example-primary-data", image: resolved, runtime: "sysbox-runc",
        resources: { cpus: "4", memory: "8g", pidsLimit: "2048" },
        inheritsResources: true, labels: ["dim"], updatedAt: "now"
      },
      labels: "dim"
    });

    expect(resolved).toBe(IMAGE_ID);
    expect(runner.calls).toEqual([
      { command: "docker", args: ["image", "pull", PINNED_IMAGE] },
      { command: "docker", args: ["image", "inspect", "--format", "{{.Id}}", PINNED_IMAGE] }
    ]);
    expect(launchArgs.at(-1)).toBe(IMAGE_ID);
    expect(launchArgs).not.toContain(PINNED_IMAGE);
  });

  it("accepts a complete local Docker image ID without running Docker", async () => {
    const runner = new ResolutionRunner([]);

    await expect(resolveSysboxRunnerImage(runner, "/state", IMAGE_ID)).resolves.toBe(IMAGE_ID);

    expect(runner.calls).toEqual([]);
  });

  it("uses a host-scoped provider identity without changing the local container name", () => {
    const executor = {
      kind: "sysbox" as const,
      phase: "ready" as const,
      containerName: "dim-ci-example-primary-local",
      volumeName: "dim-ci-example-primary-data",
      image: IMAGE_ID,
      runtime: "sysbox-runc",
      resources: { cpus: "4", memory: "8g", pidsLimit: "2048" },
      inheritsResources: true,
      labels: ["dim"],
      providerRunnerName: "dim-ci-example-primary-host-a",
      updatedAt: "now"
    };

    const args = ciRunnerContainerArgs({
      record: { projectName: "example", projectId: "project-id", name: "primary" },
      executor,
      labels: "dim"
    });

    expect(args).toEqual(expect.arrayContaining([
      "--name", executor.containerName,
      "--env", `GITEA_RUNNER_NAME=${executor.providerRunnerName}`
    ]));
  });

  it("rejects a mutable custom tag before running Docker", async () => {
    const runner = new ResolutionRunner([]);

    await expect(resolveSysboxRunnerImage(runner, "/state", "registry.example/ci/runner:latest"))
      .rejects.toThrow(/must be the built-in image, a complete Docker image ID, or a digest-pinned registry reference/);

    expect(runner.calls).toEqual([]);
  });

  it("fails closed when pulling a pinned registry reference fails", async () => {
    const runner = new ResolutionRunner([commandResult(1, "", "pull denied")]);

    await expect(resolveSysboxRunnerImage(runner, "/state", PINNED_IMAGE))
      .rejects.toThrow(/failed to pull configured CI runner image.*pull denied/);

    expect(runner.calls).toEqual([{ command: "docker", args: ["image", "pull", PINNED_IMAGE] }]);
  });

  it("fails closed when inspecting a pulled registry reference fails", async () => {
    const runner = new ResolutionRunner([commandResult(0), commandResult(1, "", "inspect denied")]);

    await expect(resolveSysboxRunnerImage(runner, "/state", PINNED_IMAGE))
      .rejects.toThrow(/failed to inspect configured CI runner image.*inspect denied/);
  });

  it("rejects a malformed image ID returned by Docker inspect", async () => {
    const runner = new ResolutionRunner([commandResult(0), commandResult(0, "sha256:short\n")]);

    await expect(resolveSysboxRunnerImage(runner, "/state", PINNED_IMAGE))
      .rejects.toThrow(/resolved CI runner image.*complete Docker image ID/);
  });

  it("rejects a mutable host image before building Docker launch arguments", () => {
    const launch = () => ciRunnerContainerArgs({
      record: { projectName: "example", projectId: "project-id", name: "primary" },
      executor: {
        kind: "sysbox",
        phase: "ready",
        containerName: "dim-ci-example-primary",
        volumeName: "dim-ci-example-primary-data",
        image: SYSBOX_CI_RUNNER_IMAGE,
        runtime: "sysbox-runc",
        resources: { cpus: "4", memory: "8g", pidsLimit: "2048" },
        inheritsResources: true,
        labels: ["dim"],
        updatedAt: "now"
      },
      labels: "dim"
    });

    expect(launch).toThrow(/Sysbox CI runner image.*Docker image ID/);
  });

  it("returns Docker's actual image ID while retaining the fixed tag only as a cache alias", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "dim-sysbox-image-"));
    stateRoots.push(stateRoot);
    const runner = new SysboxRunner();

    const imageId = await buildSysboxRunnerImage(runner, stateRoot);

    expect(imageId).toBe(IMAGE_ID);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args).toEqual(expect.arrayContaining([
      "build", "--iidfile", expect.any(String), "--tag", SYSBOX_CI_RUNNER_IMAGE
    ]));
  });

  it("treats only status 1 as an absent registration using a pinned isolated read-only probe", async () => {
    const runner = new SysboxRunner(1);

    await expect(sysboxRegistrationExists(runner, "runner-data")).resolves.toBe(false);

    expect(SYSBOX_CI_REGISTRATION_HELPER_IMAGE).toMatch(/^docker\.io\/library\/alpine@sha256:[0-9a-f]{64}$/);
    expect(runner.calls[0]?.args).toEqual(expect.arrayContaining([
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--mount", "type=volume,source=runner-data,target=/data,readonly",
      SYSBOX_CI_REGISTRATION_HELPER_IMAGE
    ]));
  });

  it("fails closed when Docker cannot execute the registration probe", async () => {
    const probe = sysboxRegistrationExists(new SysboxRunner(125), "runner-data");

    await expect(probe).rejects.toBeInstanceOf(UserError);
    await expect(probe).rejects.toThrow(/failed to inspect CI runner registration.*daemon unavailable/);
  });

  it("uses the same pinned network-isolated helper to remove registration state", async () => {
    const runner = new SysboxRunner();

    await removeSysboxRegistration(runner, "runner-data");

    expect(runner.calls[0]?.args).toEqual(expect.arrayContaining([
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      SYSBOX_CI_REGISTRATION_HELPER_IMAGE
    ]));
  });
});
