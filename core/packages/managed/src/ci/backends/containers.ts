import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ExecutionGrant } from "@slop-lab/dim-plugin-control-plane-native-git/execution";
import type { StreamingCommandRunner } from "@slop-lab/dim-core";

const labelKeys = [
  "dim.managed", "dim.owner", "dim.host", "dim.capacity", "dim.admission-generation",
  "dim.attempt", "dim.resource", "dim.kind", "dim.digest"
] as const;

/** Host-selected routing; direct image access is the default. */
export type NativeHostImageRouting = {
  readonly network: string;
  readonly blockedHostnames: readonly string[];
  readonly dockerDaemonConfig: string;
  readonly jobFiles?: readonly { readonly target: string; readonly contents: string }[];
  readonly jobEnvironmentDefaults?: Readonly<Record<string, string>>;
};

export type NativeDockerPaths = {
  readonly workspace: string;
  readonly script: string;
  readonly launcher: string;
  readonly daemonConfig: string;
  readonly jobFiles?: readonly { readonly source: string; readonly target: string }[];
};

export async function prepareNativeImages(runner: StreamingCommandRunner, claim: ExecutionGrant, signal: AbortSignal): Promise<void> {
  await prepareExecutionImage(runner, claim.descriptor.runnerBaseImage, signal);
}

export function nativeContainerArgs(claim: ExecutionGrant, paths: NativeDockerPaths, routing?: NativeHostImageRouting): string[] {
  const labels = ownershipLabels(claim);
  return [
    "run", "--detach", "--init", "--name", containerName(claim), "--runtime", "sysbox-runc",
    "--cpus", claim.descriptor.bounds.cpu, "--memory", claim.descriptor.bounds.memoryBytes,
    "--pids-limit", claim.descriptor.bounds.pids, "--oom-score-adj", "500", "--network", routing?.network ?? "bridge",
    ...(routing?.blockedHostnames ?? []).map((hostname) => `--add-host=${hostname}:127.0.0.1`),
    ...labels.flatMap((label) => ["--label", label]),
    "--mount", `type=bind,source=${paths.workspace},target=/workspace`,
    "--mount", `type=bind,source=${paths.script},target=/run/dim/job/script,readonly`,
    "--mount", `type=bind,source=${paths.launcher},target=/run/dim/runner,readonly`,
    "--mount", `type=bind,source=${paths.daemonConfig},target=/etc/docker/daemon.json,readonly`,
    ...(paths.jobFiles ?? []).flatMap(({ source }, index) => ["--mount", `type=bind,source=${source},target=/run/dim/job/config-${index},readonly`]),
    "--env", `DIM_JOB_IMAGE=${claim.descriptor.jobImage}`,
    "--env", `DIM_JOB_CPUS=${claim.descriptor.bounds.cpu}`,
    "--env", `DIM_JOB_MEMORY=${claim.descriptor.bounds.memoryBytes}`,
    "--env", `DIM_JOB_PIDS=${claim.descriptor.bounds.pids}`,
    "--entrypoint", "/bin/sh", claim.descriptor.runnerBaseImage, "/run/dim/runner"
  ];
}

export async function cleanupNativeContainer(runner: StreamingCommandRunner, claim: ExecutionGrant, kind = "sysbox", name = containerName(claim)): Promise<boolean> {
  const format = ["{{.Id}}", ...labelKeys.map((key) => `{{index .Config.Labels \"${key}\"}}`)].join("|");
  const inspected = await runner.run("docker", ["container", "inspect", name, "--format", format], {
    signal: AbortSignal.timeout(30_000)
  });
  if (inspected.exitCode !== 0) return isMissing(inspected.stderr, name);
  const [id, ...labels] = inspected.stdout.trim().split("|");
  const expected = ownershipLabels(claim, kind).map((label) => label.slice(label.indexOf("=") + 1));
  if (id === undefined || !/^[0-9a-f]{64}$/.test(id) || labels.join("|") !== expected.join("|")) return false;
  const removed = await runner.run("docker", ["container", "rm", "--force", "--volumes", id], { signal: AbortSignal.timeout(30_000) });
  return removed.exitCode === 0 || isMissing(removed.stderr, id);
}

export function nativeRunnerScript(repositoryId: string, targets: readonly string[] = [], defaults?: Readonly<Record<string, string>>): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(repositoryId)) throw new Error("invalid job working repository");
  const mounts = validateJobConfigTargets(targets).map((target, index) => {
    return `--mount type=bind,source=/run/dim/job/config-${index},target=${target},readonly`;
  }).join(" ");
  return String.raw`#!/bin/sh
set -eu
export DOCKER_HOST=unix:///run/dim/docker.sock
dockerd-entrypoint.sh --host="$DOCKER_HOST" >/dev/null 2>&1 &
daemon_pid=$!
trap 'kill "$daemon_pid" 2>/dev/null || true' EXIT
ready=false
attempt=0
while [ "$attempt" -lt 60 ]; do
  if timeout 2 docker info >/dev/null 2>&1; then ready=true; break; fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$ready" != true ]; then exit 1; fi
docker image pull "$DIM_JOB_IMAGE" >/dev/null
job_digests="$(docker image inspect "$DIM_JOB_IMAGE" --format '{{json .RepoDigests}}')"
printf '%s\n' "$job_digests" | grep -Fq -- "\"$DIM_JOB_IMAGE\""
docker run --rm --oom-score-adj 500 --network bridge --cpus "$DIM_JOB_CPUS" --memory "$DIM_JOB_MEMORY" --pids-limit "$DIM_JOB_PIDS" \
  --workdir /workspace/${repositoryId} --mount type=bind,source=/workspace,target=/workspace \
  --mount type=bind,source=/run/dim/job/script,target=/run/dim/job/script,readonly \
  ${mounts} \
  --entrypoint /bin/bash "$DIM_JOB_IMAGE" --noprofile --norc -c ${shellQuote(jobEnvironmentScript(defaults) + 'exec /bin/bash --noprofile --norc /run/dim/job/script\n')}
`;
}

export function validateJobConfigTargets(targets: readonly string[]): readonly string[] {
  if (targets.length > 16 || new Set(targets).size !== targets.length) throw new Error("invalid host job configuration files");
  for (const target of targets) {
    if (!/^\/etc\/[a-zA-Z0-9_./-]*[a-zA-Z0-9_-]$/.test(target) || posix.normalize(target) !== target) throw new Error("host-selected job configuration requires a normalized /etc file path");
  }
  return targets;
}

export async function prepareExecutionImage(runner: StreamingCommandRunner, image: string, signal: AbortSignal): Promise<void> {
  const pulled = await runner.run("docker", ["pull", image], { signal });
  if (pulled.exitCode !== 0) throw new NativeHostImageError(image);
  const inspected = await runner.run("docker", ["image", "inspect", image, "--format", "{{json .RepoDigests}}"], { signal });
  if (inspected.exitCode !== 0) throw new NativeHostImageError(image);
  let digests: unknown;
  try {
    digests = JSON.parse(inspected.stdout);
  } catch (error) {
    if (error instanceof SyntaxError) throw new NativeHostImageError(image, { cause: error });
    throw error;
  }
  if (!Array.isArray(digests) || !digests.every((item) => typeof item === "string") || !digests.includes(image)) {
    throw new NativeHostImageError(image);
  }
}

export function ownershipLabels(claim: ExecutionGrant, kind = "sysbox"): readonly string[] {
  const fields = ["true", "dim", claim.workerId, claim.slotId, claim.generationId, claim.executionId, claim.executionId, kind];
  const hash = createHash("sha256").update("dim-native-ordinary-resource-v1", "ascii");
  for (const field of fields) hash.update(`${Buffer.byteLength(field)}:`, "ascii").update(field);
  return [
    "dim.managed=true", "dim.owner=dim", `dim.host=${claim.workerId}`, `dim.capacity=${claim.slotId}`,
    `dim.admission-generation=${claim.generationId}`, `dim.attempt=${claim.executionId}`,
    `dim.resource=${claim.executionId}`, `dim.kind=${kind}`, `dim.digest=sha256:${hash.digest("hex")}`
  ];
}

export function containerName(claim: ExecutionGrant): string {
  return `dim-native-ci-${createHash("sha256").update(claim.executionId).digest("hex").slice(0, 20)}`;
}

function isMissing(stderr: string, target: string): boolean {
  return [`Error: No such container: ${target}`, `Error: No such object: ${target}`,
    `Error response from daemon: No such container: ${target}`, `Error response from daemon: No such object: ${target}`]
    .includes(stderr.trim());
}

export class NativeHostImageError extends Error {
  readonly name = "NativeHostImageError";
  readonly image: string;
  constructor(image: string, options?: ErrorOptions) {
    super(`native ordinary image digest could not be verified: ${image}`, options);
    this.image = image;
  }
}

/** Apply only missing keys, preserving image/job environment irrespective of key casing. */
export function jobEnvironmentScript(defaults: Readonly<Record<string, string>> = {}, imageEnvironment: readonly string[] = []): string {
  const explicit = imageEnvironment.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("invalid job image environment");
    return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
  });
  const fallback = Object.entries(defaults);
  if (explicit.length > 256 || fallback.length > 64) throw new Error("too many host job environment entries");
  for (const [key, value] of [...explicit, ...fallback]) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || value.includes("\0") || Buffer.byteLength(value) > 64 * 1024) {
      throw new Error("invalid host job environment entry");
    }
  }
  return explicit.map(([key, value]) => `export ${key}=${shellQuote(value)}\n`).join("")
    + fallback.map(([key, value]) => `if ! env | cut -d= -f1 | grep -iqxF ${shellQuote(key)}; then export ${key}=${shellQuote(value)}; fi\n`).join("");
}
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
