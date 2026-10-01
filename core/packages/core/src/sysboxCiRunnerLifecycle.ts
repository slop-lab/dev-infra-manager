import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "./errors.js";
import { ciRunnerContainerLabels, ciRunnerContainerPlan } from "./ciRunnerContainer.js";
import { validateLifecycleName } from "./lifecycleState.js";
import type { CiRunnerRecord, SysboxCiRunnerExecutor } from "./lifecycleTypes.js";
import { boundedCiRunnerResourceName } from "./ciRunnerVolume.js";
import { CONTROL_NETWORK, DOCKER_HUB_DIRECT_HOSTNAMES, REGISTRY_CACHE_ENDPOINT } from "./registryCache.js";
import {
  SYSBOX_CI_RUNNER_CONFIG,
  SYSBOX_CI_RUNNER_DOCKERFILE,
  SYSBOX_CI_REGISTRATION_HELPER_IMAGE,
  SYSBOX_CI_RUNNER_IMAGE
} from "./sysboxCiRunnerAssets.js";
import type { StreamingCommandRunner } from "./types.js";

export type SysboxCiRunnerContainerPlan = {
  readonly record: Pick<CiRunnerRecord, "projectName" | "projectId" | "name">;
  readonly executor: SysboxCiRunnerExecutor;
  readonly labels: string;
  readonly registration?: { readonly instanceUrl: string; readonly token: string };
  readonly registryMirror?: boolean;
};

export function ciRunnerContainerName(project: string, name: string): string {
  return resourcePrefix(project, name);
}

export function ciRunnerProviderName(project: string, name: string, hostId?: string): string {
  return hostId === undefined
    ? resourcePrefix(project, name)
    : boundedCiRunnerResourceName([
        "dim", "ci", validateLifecycleName(project, "project"), validateLifecycleName(name, "CI runner"),
        validateLifecycleName(hostId, "external Gitea host")
      ]);
}

export function ciRunnerVolumeName(project: string, name: string): string {
  return boundedCiRunnerResourceName([
    "dim", "ci", validateLifecycleName(project, "project"), validateLifecycleName(name, "CI runner"), "data"
  ]);
}

export function ciRunnerContainerArgs(plan: SysboxCiRunnerContainerPlan): string[] {
  const executor = plan.executor;
  assertDockerImageId(executor.image, "Sysbox CI runner image");
  const ownershipLabels = ciRunnerContainerLabels(ciRunnerContainerPlan(plan.record, executor));
  return [
    "run", "--detach", "--name", executor.containerName, "--restart", "unless-stopped",
    "--network", CONTROL_NETWORK,
    ...DOCKER_HUB_DIRECT_HOSTNAMES.map((hostname) => `--add-host=${hostname}:127.0.0.1`),
    "--runtime", executor.runtime,
    "--cpus", executor.resources.cpus,
    "--memory", executor.resources.memory,
    "--pids-limit", executor.resources.pidsLimit,
    "--mount", `type=volume,source=${executor.volumeName},target=/data`,
    ...(plan.registryMirror ? [
      "--mount",
      `type=volume,source=${executor.volumeName},target=/etc/docker/daemon.json,volume-subpath=docker-daemon.json,readonly`,
      "--env",
      `DIM_CI_REGISTRY_CACHE_UPSTREAM=${REGISTRY_CACHE_ENDPOINT}`
    ] : []),
    ...ownershipLabels.flatMap((label) => ["--label", label]),
    "--env", `GITEA_RUNNER_NAME=${executor.providerRunnerName ?? executor.containerName}`,
    "--env", `GITEA_RUNNER_LABELS=${plan.labels}`,
    "--env", "CONFIG_FILE=/etc/dim-act-runner.yml",
    ...(plan.registration ? [
      "--env", `GITEA_INSTANCE_URL=${plan.registration.instanceUrl}`,
      "--env", `GITEA_RUNNER_REGISTRATION_TOKEN=${plan.registration.token}`
    ] : []),
    executor.image
  ];
}

export async function resolveSysboxRunnerImage(
  runner: StreamingCommandRunner,
  stateRoot: string,
  configuredImage: string
): Promise<string> {
  if (configuredImage === SYSBOX_CI_RUNNER_IMAGE) return buildSysboxRunnerImage(runner, stateRoot);
  if (isDockerImageId(configuredImage)) return configuredImage;
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/.test(configuredImage)) {
    throw new UserError(
      "configured CI runner image must be the built-in image, a complete Docker image ID, or a digest-pinned registry reference"
    );
  }
  const pulled = await runner.run("docker", ["image", "pull", configuredImage]);
  if (pulled.exitCode !== 0) {
    throw new UserError(`failed to pull configured CI runner image '${configuredImage}': ${(pulled.stderr || pulled.stdout).trim()}`);
  }
  const inspected = await runner.run("docker", ["image", "inspect", "--format", "{{.Id}}", configuredImage]);
  if (inspected.exitCode !== 0) {
    throw new UserError(`failed to inspect configured CI runner image '${configuredImage}': ${(inspected.stderr || inspected.stdout).trim()}`);
  }
  const imageId = inspected.stdout.trim();
  assertDockerImageId(imageId, "resolved CI runner image");
  return imageId;
}

export async function buildSysboxRunnerImage(
  runner: StreamingCommandRunner,
  stateRoot: string
): Promise<string> {
  const context = path.join(stateRoot, "assets", "sysbox-ci-runner");
  await mkdir(context, { recursive: true, mode: 0o700 });
  await writeFile(path.join(context, "Dockerfile"), SYSBOX_CI_RUNNER_DOCKERFILE, { mode: 0o600 });
  await writeFile(path.join(context, "config.yml"), SYSBOX_CI_RUNNER_CONFIG, { mode: 0o600 });
  const iidDirectory = await mkdtemp(path.join(stateRoot, "assets", ".sysbox-ci-runner-iid-"));
  const iidfile = path.join(iidDirectory, "image-id");
  try {
    const result = await runner.run("docker", ["build", "--iidfile", iidfile, "--tag", SYSBOX_CI_RUNNER_IMAGE, context]);
    if (result.exitCode !== 0) {
      throw new UserError(`failed to build Sysbox CI runner image: ${result.stderr.trim()}`);
    }
    const imageId = (await readFile(iidfile, "utf8")).trim();
    assertDockerImageId(imageId, "built Sysbox CI runner image");
    return imageId;
  } finally {
    await rm(iidDirectory, { recursive: true, force: true });
  }
}

export async function sysboxRegistrationExists(
  runner: StreamingCommandRunner,
  volume: string
): Promise<boolean> {
  const result = await runner.run("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--mount", `type=volume,source=${volume},target=/data,readonly`,
    "--entrypoint", "sh", SYSBOX_CI_REGISTRATION_HELPER_IMAGE, "-c", "test -s /data/.runner"
  ]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new UserError(`failed to inspect CI runner registration: ${(result.stderr || result.stdout).trim()}`);
}

export async function removeSysboxRegistration(
  runner: StreamingCommandRunner,
  volume: string
): Promise<void> {
  const result = await runner.run("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--mount", `type=volume,source=${volume},target=/data`,
    "--entrypoint", "sh", SYSBOX_CI_REGISTRATION_HELPER_IMAGE, "-c", "rm -f /data/.runner"
  ]);
  if (result.exitCode !== 0) {
    throw new UserError(`failed to reset CI runner registration: ${result.stderr.trim()}`);
  }
}

function resourcePrefix(project: string, name: string): string {
  return boundedCiRunnerResourceName([
    "dim", "ci", validateLifecycleName(project, "project"), validateLifecycleName(name, "CI runner")
  ]);
}

function assertDockerImageId(value: string, label: string): void {
  if (!isDockerImageId(value)) throw new UserError(`${label} must be a complete Docker image ID`);
}

function isDockerImageId(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}
