import { UserError } from "./errors.js";
import type { CiRunnerConfig } from "./ciRunnerConfig.js";
import { ciRunnerResourceIdentityDigest } from "./ciRunnerResourceIdentity.js";
import type { CiRunnerExecutorKind } from "./lifecycleTypes.js";
import { validateLifecycleName } from "./lifecycleState.js";
import { boundedCiRunnerResourceName } from "./ciRunnerVolume.js";
import { CONTROL_NETWORK, DOCKER_HUB_DIRECT_HOSTNAMES, REGISTRY_CACHE_ENDPOINT } from "./registryCache.js";
import type { StreamingCommandRunner } from "./types.js";

const DOCKER_CLI_IMAGE = "docker.io/library/docker@sha256:4fa0ee1f3a7e4354c4ea34558b6d4ee32859baf4973d4c8ccc8e7fe3dd730c04";
const PROBE_LABEL_KEYS = [
  "dim.managed",
  "dim.owner",
  "dim.project",
  "dim.project-id",
  "dim.capacity",
  "dim.executor",
  "dim.resource",
  "dim.kind",
  "dim.digest"
] as const;

type ProbeResourcePlan = {
  readonly name: string;
  readonly dockerKind: "container" | "volume";
  readonly resource: "ci-workload-probe" | "ci-workload-probe-socket";
  readonly labels: readonly string[];
};

type UnlabeledProbeResourcePlan = Omit<ProbeResourcePlan, "labels">;

export type CiRunnerProbeInput = {
  readonly config: CiRunnerConfig;
  readonly hostImage: string;
  readonly runtime: string;
  readonly projectName: string;
  readonly projectId: string;
  readonly capacityName: string;
  readonly executorKind: CiRunnerExecutorKind;
};

export async function probeCiRunnerWorkloads(
  runner: StreamingCommandRunner,
  input: CiRunnerProbeInput
): Promise<void> {
  if (!/^sha256:[0-9a-f]{64}$/.test(input.hostImage)) {
    throw new UserError("CI workload probe host image must be a complete Docker image ID");
  }
  const projectName = validateLifecycleName(input.projectName, "project");
  const capacityName = validateLifecycleName(input.capacityName, "CI runner");
  if (!/^[A-Za-z0-9-]+$/.test(input.projectId)) throw new UserError(`project ID '${input.projectId}' is invalid`);
  const identity = [
    "dim", "ci",
    projectName,
    capacityName,
    input.executorKind
  ];
  const containerName = boundedCiRunnerResourceName([...identity, "workload-probe"]);
  const socketVolume = boundedCiRunnerResourceName([...identity, "workload-probe-socket"]);
  const resources = [
    probeResource(input, { name: containerName, dockerKind: "container", resource: "ci-workload-probe" }),
    probeResource(input, { name: socketVolume, dockerKind: "volume", resource: "ci-workload-probe-socket" })
  ] as const;
  await removeProbeResources(runner, resources);
  try {
    const volume = await runner.run("docker", [
      "volume", "create",
      ...resources[1].labels.flatMap((label) => ["--label", label]),
      socketVolume
    ]);
    if (await inspectProbeResource(runner, resources[1]) === undefined) {
      throw new UserError(volume.exitCode === 0
        ? "failed to verify created CI workload probe socket"
        : `failed to create CI workload probe socket: ${volume.stderr.trim()}`);
    }
    const started = await runner.run("docker", [
      "run", "--detach", "--name", containerName, "--runtime", input.runtime,
      "--network", CONTROL_NETWORK,
      "--mount", `type=volume,source=${socketVolume},target=/var/run`,
      ...DOCKER_HUB_DIRECT_HOSTNAMES.map((hostname) => `--add-host=${hostname}:127.0.0.1`),
      ...resources[0].labels.flatMap((label) => ["--label", label]),
      "--entrypoint", "/usr/local/bin/dockerd-entrypoint.sh", input.hostImage,
      "--registry-mirror", `http://${REGISTRY_CACHE_ENDPOINT}`
    ]);
    if (started.exitCode !== 0) {
      throw new UserError(`failed to start isolated CI workload probe: ${started.stderr.trim()}`);
    }
    if (await inspectProbeResource(runner, resources[0]) === undefined) {
      throw new UserError("failed to verify created CI workload probe container");
    }
    await waitForNestedDocker(runner, socketVolume);
    for (const workload of [input.config.workloads.ordinary, input.config.workloads.integration]) {
      const socket = workload.capabilities.includes("nested-docker")
        ? ["--volume", "/var/run/docker.sock:/var/run/docker.sock"]
        : [];
      const script = 'for tool do command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 127; }; done; '
        + (workload.capabilities.includes("nested-docker") ? "docker info >/dev/null" : "true");
      const result = await runner.run("docker", [
        "run", "--rm", "--pull", "always",
        "--mount", `type=volume,source=${socketVolume},target=/var/run`,
        DOCKER_CLI_IMAGE, "docker", "run", "--rm", "--pull", "always", ...socket,
        "--entrypoint", "sh", workload.image, "-ec", script, "sh", ...workload.tools
      ]);
      if (result.exitCode !== 0) {
        throw new UserError(`configured CI workload probe failed: ${(result.stderr || result.stdout).trim()}`);
      }
    }
  } finally {
    await removeProbeResources(runner, resources);
  }
}

async function waitForNestedDocker(runner: StreamingCommandRunner, socketVolume: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await runner.run("docker", [
      "run", "--rm", "--mount", `type=volume,source=${socketVolume},target=/var/run`,
      DOCKER_CLI_IMAGE, "docker", "info"
    ]);
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new UserError("isolated CI workload probe Docker daemon did not become ready");
}

function probeResource(
  input: CiRunnerProbeInput,
  plan: UnlabeledProbeResourcePlan
): ProbeResourcePlan {
  const fields = [plan.name, input.projectName, input.projectId, input.capacityName, input.executorKind, plan.resource];
  return {
    ...plan,
    labels: [
      "dim.managed=true",
      "dim.owner=dim",
      `dim.project=${input.projectName}`,
      `dim.project-id=${input.projectId}`,
      `dim.capacity=${input.capacityName}`,
      `dim.executor=${input.executorKind}`,
      `dim.resource=${plan.resource}`,
      `dim.kind=${plan.dockerKind}`,
      `dim.digest=${ciRunnerResourceIdentityDigest(fields, plan.dockerKind)}`
    ]
  };
}

async function inspectProbeResource(
  runner: StreamingCommandRunner,
  plan: ProbeResourcePlan
): Promise<string | undefined> {
  const labelTarget = plan.dockerKind === "container" ? ".Config.Labels" : ".Labels";
  const identityTarget = plan.dockerKind === "container" ? ".Id" : ".Name";
  const format = [
    `{{${identityTarget}}}`,
    ...PROBE_LABEL_KEYS.map((key) => `{{index ${labelTarget} "${key}"}}`)
  ].join("|");
  const inspected = await runner.run("docker", [plan.dockerKind, "inspect", plan.name, "--format", format]);
  if (inspected.exitCode !== 0) {
    if (new RegExp(`no such ${plan.dockerKind}`, "i").test(inspected.stderr)) return undefined;
    throw new UserError(`failed to inspect CI workload probe ${plan.dockerKind} '${plan.name}': ${inspected.stderr.trim()}`);
  }
  const [identity, ...labelValues] = inspected.stdout.trim().split("|");
  const expected = plan.labels.map((label) => label.slice(label.indexOf("=") + 1)).join("|");
  if (identity === undefined || identity.length === 0 || labelValues.join("|") !== expected) {
    throw new UserError(`Docker ${plan.dockerKind} '${plan.name}' conflicts with DIM ownership`);
  }
  return identity;
}

async function removeProbeResources(
  runner: StreamingCommandRunner,
  plans: readonly ProbeResourcePlan[]
): Promise<void> {
  const indexedPlans = plans.map((plan, planIndex) => ({ plan, planIndex }));
  const failures = new Map<number, unknown>();
  for (const dockerKind of ["container", "volume"] as const) {
    const phasePlans = indexedPlans.filter(({ plan }) => plan.dockerKind === dockerKind);
    const removals = await Promise.allSettled(phasePlans.map(async ({ plan }) => {
      const inspectedTarget = await inspectProbeResource(runner, plan);
      if (inspectedTarget === undefined) return;
      const removalTarget = plan.dockerKind === "container"
        ? inspectedTarget
        : await inspectProbeResource(runner, plan);
      if (removalTarget === undefined) return;
      const removed = await runner.run("docker", [plan.dockerKind, "rm", "--force", removalTarget]);
      if (removed.exitCode !== 0 && !new RegExp(`no such ${plan.dockerKind}`, "i").test(removed.stderr)) {
        throw new UserError(`failed to remove CI workload probe ${plan.dockerKind}: ${removed.stderr.trim()}`);
      }
    }));
    for (const [phaseIndex, removal] of removals.entries()) {
      const indexedPlan = phasePlans[phaseIndex];
      if (indexedPlan !== undefined && removal.status === "rejected") {
        failures.set(indexedPlan.planIndex, removal.reason);
      }
    }
  }
  for (const { planIndex } of indexedPlans) {
    if (failures.has(planIndex)) throw failures.get(planIndex);
  }
}
