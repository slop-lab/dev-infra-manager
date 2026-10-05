import { createHash } from "node:crypto";
import type { NativeHostClaim } from "./nativeOrdinaryClaimProtocol.js";
import { CONTROL_NETWORK, DOCKER_HUB_DIRECT_HOSTNAMES, sysboxRegistryDaemonConfig } from "./registryCache.js";
import type { StreamingCommandRunner } from "./types.js";

const labelKeys = [
  "dim.managed", "dim.owner", "dim.host", "dim.capacity", "dim.admission-generation",
  "dim.attempt", "dim.resource", "dim.kind", "dim.digest"
] as const;

export type NativeDockerPaths = {
  readonly workspace: string;
  readonly script: string;
  readonly launcher: string;
  readonly daemonConfig: string;
};

export async function prepareNativeImages(runner: StreamingCommandRunner, claim: NativeHostClaim, signal: AbortSignal): Promise<void> {
  await pullAndVerify(runner, claim.descriptor.runnerBaseImage, signal);
}

export function nativeContainerArgs(claim: NativeHostClaim, paths: NativeDockerPaths): string[] {
  const labels = ownershipLabels(claim);
  return [
    "run", "--detach", "--name", containerName(claim), "--runtime", "sysbox-runc",
    "--cpus", claim.descriptor.bounds.cpu, "--memory", claim.descriptor.bounds.memoryBytes,
    "--pids-limit", claim.descriptor.bounds.pids, "--network", CONTROL_NETWORK,
    ...DOCKER_HUB_DIRECT_HOSTNAMES.map((hostname) => `--add-host=${hostname}:127.0.0.1`),
    ...labels.flatMap((label) => ["--label", label]),
    "--mount", `type=bind,source=${paths.workspace},target=/workspace`,
    "--mount", `type=bind,source=${paths.script},target=/run/dim/job/script,readonly`,
    "--mount", `type=bind,source=${paths.launcher},target=/run/dim/runner,readonly`,
    "--mount", `type=bind,source=${paths.daemonConfig},target=/etc/docker/daemon.json,readonly`,
    "--env", `DIM_JOB_IMAGE=${claim.descriptor.jobImage}`,
    "--env", `DIM_JOB_CPUS=${claim.descriptor.bounds.cpu}`,
    "--env", `DIM_JOB_MEMORY=${claim.descriptor.bounds.memoryBytes}`,
    "--env", `DIM_JOB_PIDS=${claim.descriptor.bounds.pids}`,
    "--entrypoint", "/bin/bash", claim.descriptor.runnerBaseImage,
    "--noprofile", "--norc", "/run/dim/runner"
  ];
}

export async function cleanupNativeContainer(runner: StreamingCommandRunner, claim: NativeHostClaim): Promise<boolean> {
  const format = ["{{.Id}}", ...labelKeys.map((key) => `{{index .Config.Labels \"${key}\"}}`)].join("|");
  const inspected = await runner.run("docker", ["container", "inspect", containerName(claim), "--format", format], {
    signal: AbortSignal.timeout(30_000)
  });
  if (inspected.exitCode !== 0) return isMissing(inspected.stderr, containerName(claim));
  const [id, ...labels] = inspected.stdout.trim().split("|");
  const expected = ownershipLabels(claim).map((label) => label.slice(label.indexOf("=") + 1));
  if (id === undefined || !/^[0-9a-f]{64}$/.test(id) || labels.join("|") !== expected.join("|")) return false;
  const removed = await runner.run("docker", ["container", "rm", "--force", id], { signal: AbortSignal.timeout(30_000) });
  return removed.exitCode === 0 || isMissing(removed.stderr, id);
}

export function nativeRunnerScript(): string {
  return `#!/bin/bash
set -euo pipefail
export DOCKER_HOST=unix:///run/dim/docker.sock
dockerd-entrypoint.sh --host="$DOCKER_HOST" >/dev/null 2>&1 &
daemon_pid=$!
trap 'kill "$daemon_pid" 2>/dev/null || true' EXIT
ready=false
for attempt in {1..60}; do
  if timeout 2 docker info >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then exit 1; fi
docker image pull "$DIM_JOB_IMAGE" >/dev/null
docker image inspect "$DIM_JOB_IMAGE" --format '{{json .RepoDigests}}' | grep -Fq "\"$DIM_JOB_IMAGE\""
docker run --rm --network none --cpus "$DIM_JOB_CPUS" --memory "$DIM_JOB_MEMORY" --pids-limit "$DIM_JOB_PIDS" \
  --workdir /workspace --mount type=bind,source=/workspace,target=/workspace \
  --mount type=bind,source=/run/dim/job/script,target=/run/dim/job/script,readonly \
  --entrypoint /bin/bash "$DIM_JOB_IMAGE" --noprofile --norc /run/dim/job/script
`;
}

export function nativeDaemonConfig(): string {
  return sysboxRegistryDaemonConfig();
}

async function pullAndVerify(runner: StreamingCommandRunner, image: string, signal: AbortSignal): Promise<void> {
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

function ownershipLabels(claim: NativeHostClaim): readonly string[] {
  const fields = ["true", "dim", claim.hostId, claim.capacity, claim.admissionGeneration, claim.attemptId, claim.claimId, "native-ordinary-runner"];
  const hash = createHash("sha256").update("dim-native-ordinary-resource-v1", "ascii");
  for (const field of fields) hash.update(`${Buffer.byteLength(field)}:`, "ascii").update(field);
  return [
    "dim.managed=true", "dim.owner=dim", `dim.host=${claim.hostId}`, `dim.capacity=${claim.capacity}`,
    `dim.admission-generation=${claim.admissionGeneration}`, `dim.attempt=${claim.attemptId}`,
    `dim.resource=${claim.claimId}`, "dim.kind=native-ordinary-runner", `dim.digest=sha256:${hash.digest("hex")}`
  ];
}

function containerName(claim: NativeHostClaim): string {
  return `dim-native-ci-${createHash("sha256").update(claim.claimId).digest("hex").slice(0, 20)}`;
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
