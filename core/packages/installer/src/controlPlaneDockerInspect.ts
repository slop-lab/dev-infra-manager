import {
  ControlPlaneDockerError,
  type ControlPlaneDockerCommandResult,
  type ControlPlaneDockerRunner,
  type ControlPlaneDockerState
} from "./controlPlaneDockerTypes.js";

const project = "dim-control-plane";
const outputLimit = 64 * 1024;
const inspectTimeout = 10_000;
const formatLabels = "{{.Id}}\n{{.Driver}}\n{{json .Labels}}";
const formatVolume = "{{.Name}}\n{{.Driver}}\n{{json .Labels}}";
const formatContainer = "{{.Id}}\n{{.Name}}\n{{json .Config.Labels}}";

type ResourceKind = "network" | "volume" | "container";
type ResourcePlan = {
  readonly kind: ResourceKind;
  readonly name: string;
  readonly service?: "native-git" | "ordinary-ci";
};
type ResourceInspection =
  | { readonly kind: "missing"; readonly plan: ResourcePlan }
  | { readonly kind: "present"; readonly plan: ResourcePlan; readonly id: string };

const resources = [
  { kind: "network", name: project },
  { kind: "volume", name: "dim-control-plane-native-git-data", service: "native-git" },
  { kind: "volume", name: "dim-control-plane-ordinary-ci-data", service: "ordinary-ci" },
  { kind: "container", name: "dim-control-plane-native-git-1", service: "native-git" },
  { kind: "container", name: "dim-control-plane-ordinary-ci-1", service: "ordinary-ci" }
] as const satisfies readonly ResourcePlan[];

export async function inspectControlPlaneDocker(
  runner: ControlPlaneDockerRunner,
  deploymentId: string,
  establishedVolumes = false
): Promise<ControlPlaneDockerState> {
  await assertCompose(runner);
  const inspections: ResourceInspection[] = [];
  for (const plan of resources) inspections.push(await inspectResource(runner, plan, deploymentId));
  const projectResources = await inspectProjectResourceLists(runner);
  let presentCount = 0;
  for (const inspection of inspections) {
    switch (inspection.kind) {
      case "missing": break;
      case "present": presentCount += 1; break;
      default: assertNever(inspection);
    }
  }
  if (presentCount === 0) {
    if (projectResources.some((entries) => entries.length > 0)) conflict("unexpected Compose project resources exist");
    return { kind: "absent" };
  }
  if (presentCount !== resources.length) {
    const missingEstablishedVolume = establishedVolumes
      ? inspections.find((inspection) => inspection.kind === "missing" && inspection.plan.kind === "volume")
      : undefined;
    if (missingEstablishedVolume !== undefined) {
      conflict(`established control-plane data volume '${missingEstablishedVolume.plan.name}' is missing; refusing to recreate it because this is a fatal data-loss condition`);
    }
    conflict("control-plane Docker resources are partial");
  }

  const network = requiredInspection(inspections, "network");
  const nativeGit = requiredInspection(inspections, "container", "native-git");
  const ordinaryCi = requiredInspection(inspections, "container", "ordinary-ci");
  const nativeVolume = requiredInspection(inspections, "volume", "native-git");
  const ordinaryVolume = requiredInspection(inspections, "volume", "ordinary-ci");
  assertExactSet(projectResources[0] ?? [], [network.id], "Compose network");
  assertExactSet(projectResources[1] ?? [], [nativeVolume.plan.name, ordinaryVolume.plan.name], "Compose volume");
  assertExactSet(projectResources[2] ?? [], [nativeGit.id, ordinaryCi.id], "Compose container");
  await assertExactUsers(runner, { kind: "network", name: project, expected: [nativeGit.id, ordinaryCi.id] });
  await assertExactUsers(runner, { kind: "volume", name: nativeVolume.plan.name, expected: [nativeGit.id] });
  await assertExactUsers(runner, { kind: "volume", name: ordinaryVolume.plan.name, expected: [ordinaryCi.id] });
  return { kind: "owned", nativeGitContainerId: nativeGit.id, ordinaryCiContainerId: ordinaryCi.id };
}

export async function inspectControlPlaneServiceContainer(
  runner: ControlPlaneDockerRunner,
  deploymentId: string,
  service: "native-git" | "ordinary-ci"
): Promise<string> {
  await assertCompose(runner);
  const plan = resources.find((resource) => resource.kind === "container" && resource.service === service);
  if (plan === undefined) return conflict("control-plane service resource plan is missing");
  const inspection = await inspectResource(runner, plan, deploymentId);
  switch (inspection.kind) {
    case "present": return inspection.id;
    case "missing": return conflict(`control-plane ${service} container is missing`);
    default: return assertNever(inspection);
  }
}

async function assertCompose(runner: ControlPlaneDockerRunner): Promise<void> {
  const result = await runInspect(runner, ["compose", "version", "--short"]);
  const match = /^v?(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\n?$/.exec(result.stdout);
  const major = match?.[1];
  if (result.exitCode !== 0 || result.stderr !== "" || major === undefined || Number(major) < 2) {
    conflict("Docker Compose v2 or newer is required");
  }
}

async function inspectResource(
  runner: ControlPlaneDockerRunner,
  plan: ResourcePlan,
  deploymentId: string
): Promise<ResourceInspection> {
  const format = inspectFormat(plan.kind);
  const result = await runInspect(runner, [plan.kind, "inspect", plan.name, "--format", format]);
  if (result.exitCode !== 0) {
    if (isMissing(plan, result)) return { kind: "missing", plan };
    conflict(`failed to inspect Docker ${plan.kind} '${plan.name}'`);
  }
  if (result.stderr !== "") conflict(`Docker ${plan.kind} '${plan.name}' inspection was noisy`);
  const lines = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1).split("\n") : result.stdout.split("\n");
  if (lines.length !== 3) conflict(`Docker ${plan.kind} '${plan.name}' inspection was malformed`);
  const id = lines[0];
  const detail = lines[1];
  const labels = parseLabels(lines[2]);
  if (id === undefined || detail === undefined || labels === undefined) conflict(`Docker ${plan.kind} '${plan.name}' inspection was malformed`);
  assertResourceIdentity(plan, id, detail);
  assertLabels(plan, labels, deploymentId);
  return { kind: "present", plan, id: plan.kind === "volume" ? plan.name : id };
}

async function inspectProjectResourceLists(runner: ControlPlaneDockerRunner): Promise<readonly (readonly string[])[]> {
  return Promise.all([
    list(runner, ["network", "ls", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"]),
    list(runner, ["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"]),
    list(runner, ["container", "ls", "--all", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"])
  ]);
}

async function assertExactUsers(
  runner: ControlPlaneDockerRunner,
  target: { readonly kind: "network" | "volume"; readonly name: string; readonly expected: readonly string[] }
): Promise<void> {
  const users = await list(runner, ["container", "ls", "--all", "--no-trunc", "--filter", `${target.kind}=${target.name}`, "--format", "{{.ID}}"]);
  assertExactSet(users, target.expected, `${target.kind} users`);
}

async function list(runner: ControlPlaneDockerRunner, args: readonly string[]): Promise<readonly string[]> {
  const result = await runInspect(runner, args);
  if (result.exitCode !== 0 || result.stderr !== "") conflict("Docker resource enumeration failed");
  if (result.stdout === "") return [];
  if (!result.stdout.endsWith("\n")) conflict("Docker resource enumeration was malformed");
  const entries = result.stdout.slice(0, -1).split("\n");
  if (entries.some((entry) => entry.length === 0)) conflict("Docker resource enumeration was malformed");
  return entries;
}

function assertResourceIdentity(plan: ResourcePlan, id: string, detail: string): void {
  switch (plan.kind) {
    case "network":
      if (!/^[0-9a-f]{64}$/.test(id) || detail !== "bridge") conflict(`Docker network '${plan.name}' is malformed`);
      return;
    case "volume":
      if (id !== plan.name || detail !== "local") conflict(`Docker volume '${plan.name}' is malformed`);
      return;
    case "container":
      if (!/^[0-9a-f]{64}$/.test(id) || detail !== `/${plan.name}`) conflict(`Docker container '${plan.name}' is malformed`);
      return;
    default:
      assertNever(plan.kind);
  }
}

function assertLabels(plan: ResourcePlan, labels: Readonly<Record<string, string>>, deploymentId: string): void {
  const resource = plan.kind === "container" ? "service" : plan.kind;
  const expectedDim = {
    "org.dim.managed": "true",
    "org.dim.bundle": "control-plane",
    "org.dim.deployment": deploymentId,
    "org.dim.resource": resource,
    ...(plan.service === undefined ? {} : { "org.dim.service": plan.service })
  };
  const actualDimKeys = Object.keys(labels).filter((key) => key.startsWith("org.dim.")).sort();
  if (actualDimKeys.join("\0") !== Object.keys(expectedDim).sort().join("\0")) conflict(`Docker ${plan.kind} '${plan.name}' has foreign DIM labels`);
  for (const [key, value] of Object.entries(expectedDim)) {
    if (labels[key] !== value) conflict(`Docker ${plan.kind} '${plan.name}' has foreign DIM labels`);
  }
  if (labels["com.docker.compose.project"] !== project) conflict(`Docker ${plan.kind} '${plan.name}' has foreign Compose labels`);
  switch (plan.kind) {
    case "network":
      if (labels["com.docker.compose.network"] !== project) conflict(`Docker network '${plan.name}' has foreign Compose labels`);
      return;
    case "volume":
      if (labels["com.docker.compose.volume"] !== plan.name) conflict(`Docker volume '${plan.name}' has foreign Compose labels`);
      return;
    case "container":
      if (labels["com.docker.compose.service"] !== plan.service
        || labels["com.docker.compose.container-number"] !== "1" || labels["com.docker.compose.oneoff"] !== "False") {
        conflict(`Docker container '${plan.name}' has foreign Compose labels`);
      }
      return;
    default:
      assertNever(plan.kind);
  }
}

function parseLabels(value: string | undefined): Readonly<Record<string, string>> | undefined {
  if (value === undefined || Buffer.byteLength(value) > outputLimit) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const labels: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== "string") return undefined;
    labels[key] = entry;
  }
  return labels;
}

function requiredInspection(
  inspections: readonly ResourceInspection[],
  kind: ResourceKind,
  service?: "native-git" | "ordinary-ci"
): Extract<ResourceInspection, { readonly kind: "present" }> {
  const inspection = inspections.find((entry) => entry.plan.kind === kind && entry.plan.service === service);
  if (inspection === undefined) return conflict("control-plane Docker resources are partial");
  switch (inspection.kind) {
    case "present": return inspection;
    case "missing": return conflict("control-plane Docker resources are partial");
    default: return assertNever(inspection);
  }
}

function assertExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
  if ([...actual].sort().join("\0") !== [...expected].sort().join("\0")) conflict(`${label} set is unexpected`);
}

function isMissing(plan: ResourcePlan, result: ControlPlaneDockerCommandResult): boolean {
  const diagnostic = result.stderr.trim().toLowerCase();
  if (result.stdout !== "" && result.stdout !== "\n") return false;
  switch (plan.kind) {
    case "network": return diagnostic === `error response from daemon: network ${plan.name} not found`;
    case "volume": return diagnostic === `error response from daemon: get ${plan.name}: no such volume`;
    case "container":
      return [
        `error response from daemon: no such container: ${plan.name}`,
        `error response from daemon: no such object: ${plan.name}`,
        `error: no such container: ${plan.name}`,
        `error: no such object: ${plan.name}`
      ].includes(diagnostic);
    default: return assertNever(plan.kind);
  }
}

function inspectFormat(kind: ResourceKind): string {
  switch (kind) {
    case "network": return formatLabels;
    case "volume": return formatVolume;
    case "container": return formatContainer;
    default: return assertNever(kind);
  }
}

async function runInspect(runner: ControlPlaneDockerRunner, args: readonly string[]): Promise<ControlPlaneDockerCommandResult> {
  const result = await runner.run({ args, timeoutMilliseconds: inspectTimeout, maximumOutputBytes: outputLimit });
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > outputLimit) conflict("Docker inspection output exceeded its limit");
  return result;
}

function conflict(message: string): never {
  throw new ControlPlaneDockerError(message);
}

function assertNever(value: never): never {
  throw new ControlPlaneDockerError(`unexpected control-plane Docker variant: ${String(value)}`);
}
