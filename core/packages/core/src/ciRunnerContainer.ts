import { UserError } from "./errors.js";
import { ciRunnerResourceIdentityDigest } from "./ciRunnerResourceIdentity.js";
import { validateLifecycleName } from "./lifecycleState.js";
import type { CiRunnerRecord, QemuCiRunnerExecutor, SysboxCiRunnerExecutor } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";

type CiRunnerContainerIdentity = {
  readonly name: string;
  readonly project: string;
  readonly projectId: string;
  readonly runner: string;
};

export type CiRunnerContainerPlan = CiRunnerContainerIdentity & (
  | { readonly executor: "sysbox"; readonly resource: "ci-runner" }
  | { readonly executor: "qemu"; readonly resource: "ci-qemu-supervisor" }
);

const CONTAINER_LABEL_KEYS = [
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

const CONTAINER_INSPECT_FORMAT = [
  "{{.Id}}",
  ...CONTAINER_LABEL_KEYS.map((key) => `{{index .Config.Labels "${key}"}}`)
].join("|");

export function ciRunnerContainerPlan(
  record: Pick<CiRunnerRecord, "projectName" | "projectId" | "name">,
  executor: SysboxCiRunnerExecutor | QemuCiRunnerExecutor
): CiRunnerContainerPlan {
  switch (executor.kind) {
    case "sysbox":
      return {
        name: executor.containerName,
        project: record.projectName,
        projectId: record.projectId,
        runner: record.name,
        executor: executor.kind,
        resource: "ci-runner"
      };
    case "qemu":
      return {
        name: executor.supervisorName,
        project: record.projectName,
        projectId: record.projectId,
        runner: record.name,
        executor: executor.kind,
        resource: "ci-qemu-supervisor"
      };
    default:
      return assertNever(executor);
  }
}

export function ciRunnerContainerLabels(plan: CiRunnerContainerPlan): readonly string[] {
  const project = validateLifecycleName(plan.project, "project");
  const runner = validateLifecycleName(plan.runner, "CI runner");
  if (!/^[A-Za-z0-9-]+$/.test(plan.projectId)) throw new UserError(`project ID '${plan.projectId}' is invalid`);
  const fields = [plan.name, project, plan.projectId, runner, plan.executor, plan.resource];
  return [
    "dim.managed=true",
    "dim.owner=dim",
    `dim.project=${project}`,
    `dim.project-id=${plan.projectId}`,
    `dim.capacity=${runner}`,
    `dim.executor=${plan.executor}`,
    `dim.resource=${plan.resource}`,
    "dim.kind=container",
    `dim.digest=${ciRunnerResourceIdentityDigest(fields, "container")}`
  ];
}

export async function inspectCiRunnerContainer(
  runner: StreamingCommandRunner,
  plan: CiRunnerContainerPlan
): Promise<string | undefined> {
  const inspected = await runner.run("docker", [
    "container", "inspect", plan.name, "--format", CONTAINER_INSPECT_FORMAT
  ]);
  if (inspected.exitCode !== 0) {
    if (isMissingContainer(inspected.stderr, plan.name)) return undefined;
    throw new UserError(`failed to inspect CI runner container '${plan.name}': ${inspected.stderr.trim()}`);
  }
  const [containerId, ...labelValues] = inspected.stdout.trim().split("|");
  const expected = ciRunnerContainerLabels(plan).map((label) => label.slice(label.indexOf("=") + 1)).join("|");
  if (containerId === undefined || containerId.length === 0 || labelValues.join("|") !== expected) {
    throw new UserError(`Docker container '${plan.name}' conflicts with DIM ownership`);
  }
  return containerId;
}

export async function startCiRunnerContainer(
  runner: StreamingCommandRunner,
  plan: CiRunnerContainerPlan
): Promise<void> {
  const containerId = await inspectCiRunnerContainer(runner, plan);
  if (containerId === undefined) throw new UserError(`CI runner container '${plan.name}' does not exist`);
  const started = await runner.run("docker", ["start", containerId]);
  if (started.exitCode !== 0) {
    throw new UserError(`failed to start CI runner container '${plan.name}': ${started.stderr.trim()}`);
  }
}

export async function stopCiRunnerContainer(
  runner: StreamingCommandRunner,
  plan: CiRunnerContainerPlan
): Promise<void> {
  const containerId = await inspectCiRunnerContainer(runner, plan);
  if (containerId === undefined) return;
  const stopped = await runner.run("docker", ["stop", containerId]);
  if (stopped.exitCode !== 0 && !isMissingContainer(stopped.stderr, containerId)) {
    throw new UserError(`failed to stop CI runner container '${plan.name}': ${stopped.stderr.trim()}`);
  }
}

export async function removeCiRunnerContainer(
  runner: StreamingCommandRunner,
  plan: CiRunnerContainerPlan
): Promise<void> {
  const containerId = await inspectCiRunnerContainer(runner, plan);
  if (containerId === undefined) return;
  const removed = await runner.run("docker", ["container", "rm", "--force", containerId]);
  if (removed.exitCode !== 0 && !isMissingContainer(removed.stderr, containerId)) {
    throw new UserError(`failed to remove CI runner container '${plan.name}': ${removed.stderr.trim()}`);
  }
}

function isMissingContainer(stderr: string, target: string): boolean {
  const diagnostic = stderr.trim();
  return diagnostic === `Error: No such container: ${target}`
    || diagnostic === `Error: No such object: ${target}`
    || diagnostic === `Error response from daemon: No such container: ${target}`
    || diagnostic === `Error response from daemon: No such object: ${target}`;
}

function assertNever(value: never): never {
  throw new UserError(`unsupported CI runner executor: ${String(value)}`);
}
