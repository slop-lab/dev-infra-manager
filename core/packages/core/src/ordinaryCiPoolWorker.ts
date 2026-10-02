import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserError } from "./errors.js";
import { CONTROL_NETWORK, DOCKER_HUB_DIRECT_HOSTNAMES, REGISTRY_CACHE_ENDPOINT, sysboxRegistryDaemonConfig } from "./registryCache.js";
import type { CiRunnerRecord, CiRunnerResources } from "./lifecycleTypes.js";
import type { CiRunnerRegistration } from "./ciCoordinator.js";
import type { StreamingCommandRunner } from "./types.js";

export type OrdinaryPoolClaim = {
  readonly claimId: string;
  readonly admissionId: string;
  readonly jobId: number;
  readonly projectId: string;
  readonly projectName: string;
  readonly organization: string;
  readonly organizationId: number;
  readonly jobImage: string;
  readonly runnerLabel: string;
  readonly leaseMilliseconds: number;
};

export type OrdinaryPoolWorkerPlan = {
  readonly claim: OrdinaryPoolClaim;
  readonly hostId: string;
  readonly capacity: string;
  readonly runnerImage: string;
  readonly runnerRuntime: string;
  readonly resources: CiRunnerResources;
  readonly signal?: AbortSignal;
};

export type OrdinaryPoolJobDependencies = {
  readonly runner: StreamingCommandRunner;
  readonly prepareRegistration: (claim: OrdinaryPoolClaim) => Promise<CiRunnerRegistration>;
  readonly renewClaim: (claim: OrdinaryPoolClaim, signal: AbortSignal) => Promise<number>;
  readonly releaseClaim: (claim: OrdinaryPoolClaim) => Promise<void>;
};

export type OrdinaryPoolOwnership = {
  readonly hostId: string;
  readonly capacity: string;
  readonly claimId: string;
  readonly projectId: string;
};

const OWNERSHIP_KEYS = [
  "dim.managed", "dim.owner", "dim.host", "dim.capacity", "dim.claim", "dim.project-id", "dim.resource"
] as const;

export function assertOrdinaryPoolCapacityAvailable(
  records: readonly Pick<CiRunnerRecord, "name" | "executor">[],
  capacity: string
): void {
  const conflict = records.find((record) =>
    record.executor.kind === "sysbox" && record.executor.phase !== "stopped"
  );
  if (conflict !== undefined) {
    throw new UserError(
      `legacy Project-scoped Sysbox runner '${conflict.name}' conflicts with ordinary CI pool capacity '${capacity}'`
    );
  }
}

export function ordinaryPoolContainerArgs(
  plan: OrdinaryPoolWorkerPlan,
  credential: { readonly file: string; readonly registryConfigFile: string; readonly instanceUrl: string }
): string[] {
  assertPlan(plan);
  const name = containerName(ownership(plan));
  const labels = ownershipLabels(ownership(plan));
  return [
    "run", "--rm", "--name", name,
    "--runtime", plan.runnerRuntime,
    "--cpus", plan.resources.cpus,
    "--memory", plan.resources.memory,
    "--pids-limit", plan.resources.pidsLimit,
    "--network", CONTROL_NETWORK,
    ...DOCKER_HUB_DIRECT_HOSTNAMES.map((hostname) => `--add-host=${hostname}:127.0.0.1`),
    ...labels.flatMap((label) => ["--label", label]),
    "--mount", `type=bind,source=${credential.file},target=/run/secrets/gitea-registration-token,readonly`,
    "--mount", `type=bind,source=${credential.registryConfigFile},target=/etc/docker/daemon.json,readonly`,
    "--env", `DIM_CI_REGISTRY_CACHE_UPSTREAM=${REGISTRY_CACHE_ENDPOINT}`,
    "--env", `GITEA_INSTANCE_URL=${credential.instanceUrl}`,
    "--env", "GITEA_RUNNER_REGISTRATION_TOKEN_FILE=/run/secrets/gitea-registration-token",
    "--env", `GITEA_RUNNER_NAME=${name}`,
    "--env", `GITEA_RUNNER_LABELS=${plan.claim.runnerLabel}:docker://${plan.claim.jobImage}`,
    "--env", "GITEA_RUNNER_EPHEMERAL=1",
    "--env", "GITEA_RUNNER_ONCE=1",
    "--env", "CONFIG_FILE=/etc/dim-act-runner.yml",
    plan.runnerImage
  ];
}

export async function runOrdinaryPoolClaim(
  dependencies: OrdinaryPoolJobDependencies,
  plan: OrdinaryPoolWorkerPlan
): Promise<void> {
  assertPlan(plan);
  const stopRenewal = new AbortController();
  const stopExecution = new AbortController();
  const executionSignal = plan.signal === undefined
    ? stopExecution.signal
    : AbortSignal.any([plan.signal, stopExecution.signal]);
  let credentialRoot: string | undefined;
  let workError: unknown;
  let renewalError: unknown;
  let renewal: Promise<void> | undefined;
  try {
    const leaseMilliseconds = await dependencies.renewClaim(plan.claim, executionSignal);
    renewal = maintainLease(dependencies, plan.claim, leaseMilliseconds, stopRenewal.signal)
      .catch((error: unknown) => {
        if (stopRenewal.signal.aborted && error === stopRenewal.signal.reason) return;
        renewalError = error;
        stopExecution.abort(error);
      });
    const registration = await dependencies.prepareRegistration(plan.claim);
    await dependencies.renewClaim(plan.claim, executionSignal);
    executionSignal.throwIfAborted();
    credentialRoot = await mkdtemp(join(tmpdir(), "dim-ordinary-ci-credentials-"));
    const credentialFile = join(credentialRoot, "runner.env");
    const registryConfigFile = join(credentialRoot, "docker-daemon.json");
    await writeFile(credentialFile, credentialContents(registration), { mode: 0o600 });
    await writeFile(registryConfigFile, sysboxRegistryDaemonConfig(), { mode: 0o600 });
    const result = await dependencies.runner.run(
      "docker",
      ordinaryPoolContainerArgs(plan, { file: credentialFile, registryConfigFile, instanceUrl: registration.instanceUrl }),
      { signal: executionSignal }
    );
    if (result.exitCode !== 0) {
      throw new UserError(`ordinary CI runner exited with status ${result.exitCode}: ${(result.stderr || result.stdout).trim()}`);
    }
  } catch (error) {
    workError = error;
  } finally {
    stopRenewal.abort();
    await renewal;
    if (credentialRoot !== undefined) await rm(credentialRoot, { recursive: true, force: true });
  }
  if (!await cleanupOwnedContainer(dependencies.runner, ownership(plan))) {
    throw new UserError(`failed to clean up ordinary CI runner for claim '${plan.claim.claimId}'`);
  }
  await dependencies.releaseClaim(plan.claim);
  if (renewalError !== undefined) throw renewalError;
  if (workError !== undefined) throw workError;
}

export async function recoverOrdinaryPoolClaim(
  runner: StreamingCommandRunner,
  owner: OrdinaryPoolOwnership
): Promise<void> {
  if (!await cleanupOwnedContainer(runner, owner)) {
    throw new UserError(`failed to clean up expired ordinary CI runner for claim '${owner.claimId}'`);
  }
}

function credentialContents(registration: CiRunnerRegistration): string {
  if ([registration.instanceUrl, registration.token].some((value) => value.includes("\n") || value.includes("\r") || value.includes("\0"))) {
    throw new UserError("ordinary CI runner registration contains an unsafe environment value");
  }
  return `${registration.token}\n`;
}

async function cleanupOwnedContainer(runner: StreamingCommandRunner, owner: OrdinaryPoolOwnership): Promise<boolean> {
  const name = containerName(owner);
  const format = ["{{.Id}}", ...OWNERSHIP_KEYS.map((key) => `{{index .Config.Labels \"${key}\"}}`)].join("|");
  const inspected = await runner.run("docker", ["container", "inspect", name, "--format", format], {
    signal: AbortSignal.timeout(30_000)
  });
  if (inspected.exitCode !== 0) return isMissingContainer(inspected.stderr, name);
  const [id, ...actual] = inspected.stdout.trim().split("|");
  const expected = ownershipLabels(owner).map((label) => label.slice(label.indexOf("=") + 1));
  if (id === undefined || id.length === 0 || actual.join("|") !== expected.join("|")) return false;
  const removed = await runner.run("docker", ["container", "rm", "--force", id], {
    signal: AbortSignal.timeout(30_000)
  });
  return removed.exitCode === 0 || isMissingContainer(removed.stderr, id);
}

function ownershipLabels(owner: OrdinaryPoolOwnership): readonly string[] {
  return [
    "dim.managed=true",
    "dim.owner=dim",
    `dim.host=${owner.hostId}`,
    `dim.capacity=${owner.capacity}`,
    `dim.claim=${owner.claimId}`,
    `dim.project-id=${owner.projectId}`,
    "dim.resource=ci-ordinary-job"
  ];
}

function containerName(owner: OrdinaryPoolOwnership): string {
  const digest = createHash("sha256").update(owner.claimId).digest("hex").slice(0, 12);
  return `dim-ci-ordinary-${owner.hostId}-${owner.capacity}-${digest}`;
}

function ownership(plan: OrdinaryPoolWorkerPlan): OrdinaryPoolOwnership {
  return { hostId: plan.hostId, capacity: plan.capacity, claimId: plan.claim.claimId, projectId: plan.claim.projectId };
}

async function maintainLease(
  dependencies: OrdinaryPoolJobDependencies,
  claim: OrdinaryPoolClaim,
  initialDuration: number,
  signal: AbortSignal
): Promise<void> {
  let leaseMilliseconds = initialDuration;
  while (!signal.aborted) {
    const delay = Math.max(1, Math.floor(leaseMilliseconds / 2));
    await wait(delay, signal);
    if (!signal.aborted) leaseMilliseconds = await dependencies.renewClaim(claim, signal);
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
  });
}

function assertPlan(plan: OrdinaryPoolWorkerPlan): void {
  if (plan.runnerRuntime !== "sysbox-runc") throw new UserError("ordinary CI pool requires the Sysbox runtime");
  for (const [label, value] of [["host ID", plan.hostId], ["capacity", plan.capacity], ["claim ID", plan.claim.claimId], ["Project ID", plan.claim.projectId], ["runner label", plan.claim.runnerLabel]] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new UserError(`ordinary CI pool ${label} is invalid`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(plan.runnerImage)) throw new UserError("ordinary CI pool runner image must be a Docker image ID");
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/.test(plan.claim.jobImage)) {
    throw new UserError("ordinary CI pool job image must be digest-pinned without a tag");
  }
}

function isMissingContainer(stderr: string, target: string): boolean {
  const diagnostic = stderr.trim();
  return diagnostic === `Error: No such container: ${target}`
    || diagnostic === `Error: No such object: ${target}`
    || diagnostic === `Error response from daemon: No such container: ${target}`
    || diagnostic === `Error response from daemon: No such object: ${target}`;
}
