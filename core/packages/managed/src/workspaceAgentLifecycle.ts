import { UserError } from "@slop-lab/dim-core";
import type { LifecycleOptions, WorkspacePhase, WorkspaceRecord } from "./lifecycleTypes.js";
import { workspaceRuntimePlan } from "./runtimeBackends.js";
import type { CommandResult, StreamingCommandRunner } from "@slop-lab/dim-core";
import {
  workspaceAgentContainerArgs,
  workspaceAgentIdentity,
  workspaceAgentNetworkLabels,
  workspaceAgentVolumeLabels,
  type WorkspaceAgentVolumeResource
} from "./workspaceAgentRuntime.js";
import { workspaceGitBaseUrl } from "./workspaceLifecycleTypes.js";
import { assertWorkspaceSysboxRuntime } from "./workspaceSysboxRuntime.js";
import { inspectWorkspaceAgentContainer } from "./workspaceAgentInspection.js";
import { reconcileRecommendedWorkspaceResourceBudget } from "./workspaceAgentResources.js";
import { notifyWorkspaceAgentRelayPhase, startWorkspaceAgentRelay } from "./workspaceAgentRelay.js";
import { combineWorkspaceLifecycleFailures } from "./workspaceLifecycleError.js";
import { waitForWorkspaceRuntime } from "./workspaceContainer.js";

const inspectVolumeLabels = "{{json .Labels}}";

type ReconcileWorkspaceAgentInput = {
  readonly options: LifecycleOptions;
  readonly record: WorkspaceRecord;
  readonly outerContainerId: string;
  readonly relayStarted?: () => void;
};

export async function reconcileWorkspaceAgent(
  runner: StreamingCommandRunner,
  input: ReconcileWorkspaceAgentInput
): Promise<string> {
  await assertWorkspaceSysboxRuntime(runner);
  const image = await resolveImage(runner, workspaceRuntimePlan(input.record.runtimeBackend, input.options).image);
  const identity = workspaceAgentIdentity(input.record);
  await ensureResource(runner, "network", identity.networkName, workspaceAgentNetworkLabels(input.record));
  await ensureResource(runner, "volume", identity.homeVolumeName, workspaceAgentVolumeLabels(input.record, "agent-home"));
  await ensureResource(runner, "volume", identity.checkoutVolumeName, workspaceAgentVolumeLabels(input.record, "agent-checkout"));
  await ensureResource(runner, "volume", identity.dockerVolumeName, workspaceAgentVolumeLabels(input.record, "agent-docker"));
  await connectOuter(runner, identity.networkName, input.outerContainerId);
  let container = await inspectWorkspaceAgentContainer(runner, input.record);
  if (container !== undefined && container.image !== image) {
    const removed = await runner.run("docker", ["container", "rm", "--force", container.id]);
    if (removed.exitCode !== 0 && !isMissing(removed.stderr, "container", container.id)) {
      throw commandError("replace recommended workspace agent", removed);
    }
    container = undefined;
  }
  if (container === undefined) {
    const created = await runner.run("docker", workspaceAgentContainerArgs(input.record, image));
    if (created.exitCode !== 0) throw commandError("create recommended workspace agent", created);
    container = await inspectWorkspaceAgentContainer(runner, input.record);
    if (container === undefined) throw new UserError("created recommended workspace agent is unavailable");
  }
  await reconcileRecommendedWorkspaceResourceBudget(runner, input.record, input.outerContainerId);
  if (!container.running) {
    const started = await runner.run("docker", ["start", container.id]);
    if (started.exitCode !== 0) throw commandError("start recommended workspace agent", started);
  }
  await waitForWorkspaceRuntime(runner, container.id, "docker");
  await startWorkspaceAgentRelay(runner, identity.networkName, input.outerContainerId);
  input.relayStarted?.();
  await initializeCheckout(runner, input.record, container.id);
  return container.id;
}

export async function streamWorkspaceAgentCommand(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  command: readonly string[],
  tty: boolean
): Promise<number> {
  const container = await inspectWorkspaceAgentContainer(runner, record);
  if (container === undefined || !container.running) {
    throw new UserError(`recommended agent for workspace '${record.name}' is not running; run dim workspace setup`);
  }
  const args = ["exec", "--user", "dim", "--workdir", "/workspace", "--interactive"];
  if (tty) args.push("--tty");
  args.push(container.id, ...command);
  return runner.runStreaming("docker", args, { terminal: tty });
}

export async function notifyRecommendedWorkspaceRelayPhase(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  outerContainerId: string,
  phase: WorkspacePhase
): Promise<void> {
  if (record.environment === "recommended") {
    try {
      await notifyWorkspaceAgentRelayPhase(runner, outerContainerId, phase);
    } catch (error) {
      const stopped = await runner.run("docker", ["stop", outerContainerId]);
      if (stopped.exitCode !== 0 && !isMissing(stopped.stderr, "container", outerContainerId)) {
        throw combineWorkspaceLifecycleFailures(error, commandError("stop workspace after relay phase failure", stopped));
      }
      throw error;
    }
  }
}

export async function removeWorkspaceAgentContainer(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<void> {
  const container = await inspectWorkspaceAgentContainer(runner, record);
  if (container === undefined) return;
  const removed = await runner.run("docker", ["container", "rm", "--force", container.id]);
  if (removed.exitCode !== 0 && !isMissing(removed.stderr, "container", container.id)) {
    throw commandError("remove recommended workspace agent", removed);
  }
}

export async function stopWorkspaceAgent(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<void> {
  const container = await inspectWorkspaceAgentContainer(runner, record);
  if (container === undefined || !container.running) return;
  const stopped = await runner.run("docker", ["stop", container.id]);
  if (stopped.exitCode !== 0 && !isMissing(stopped.stderr, "container", container.id)) {
    throw commandError("stop recommended workspace agent", stopped);
  }
}

export async function discardWorkspaceAgentResources(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  keepVolumes: boolean,
  outerContainerId: string | null = record.containerName
): Promise<void> {
  const identity = workspaceAgentIdentity(record);
  await removeWorkspaceAgentContainer(runner, record);
  if (!keepVolumes) {
    await removeResource(runner, "volume", identity.homeVolumeName, workspaceAgentVolumeLabels(record, "agent-home"));
    await removeResource(runner, "volume", identity.checkoutVolumeName, workspaceAgentVolumeLabels(record, "agent-checkout"));
    await removeResource(runner, "volume", identity.dockerVolumeName, workspaceAgentVolumeLabels(record, "agent-docker"));
  }
  await removeResource(
    runner,
    "network",
    identity.networkName,
    workspaceAgentNetworkLabels(record),
    outerContainerId ?? undefined
  );
}

async function initializeCheckout(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  containerId: string
): Promise<void> {
  const source = new URL(workspaceGitBaseUrl(record));
  const relay = new URL(source.pathname.endsWith("/") ? source.pathname : `${source.pathname}/`, "http://dim-workspace:19419");
  const repositoryUrl = new URL(`${record.rootRepositoryAlias}.git`, relay).toString();
  const result = await runner.run("docker", [
    "exec", "--user", "dim", "--workdir", "/workspace",
    "--env", `DIM_AGENT_REPOSITORY_URL=${repositoryUrl}`,
    "--env", `DIM_AGENT_ROOT_COMMIT=${record.rootCommit}`,
    "--env", `DIM_AGENT_WORKSPACE_ID=${record.workspaceId}`,
    "--env", `GIT_AUTHOR_NAME=${record.gitUserName}`,
    "--env", `GIT_AUTHOR_EMAIL=${record.gitUserEmail}`,
    "--env", `GIT_COMMITTER_NAME=${record.gitUserName}`,
    "--env", `GIT_COMMITTER_EMAIL=${record.gitUserEmail}`,
    containerId, "dim-agent-checkout"
  ]);
  if (result.exitCode !== 0) throw commandError("initialize recommended workspace checkout", result);
}

async function ensureResource(
  runner: StreamingCommandRunner,
  kind: "network" | "volume",
  name: string,
  labels: readonly string[]
): Promise<void> {
  const format = kind === "network" ? inspectVolumeLabels : inspectVolumeLabels;
  const inspected = await runner.run("docker", [kind, "inspect", name, "--format", format]);
  if (inspected.exitCode === 0) {
    assertLabels(name, inspected.stdout, labels);
    return;
  }
  if (!isMissing(inspected.stderr, kind, name)) throw commandError(`inspect recommended agent ${kind}`, inspected);
  const created = await runner.run("docker", [kind, "create", ...labels.flatMap((label) => ["--label", label]), name]);
  if (created.exitCode !== 0) throw commandError(`create recommended agent ${kind}`, created);
  const verified = await runner.run("docker", [kind, "inspect", name, "--format", format]);
  if (verified.exitCode !== 0) throw commandError(`verify recommended agent ${kind}`, verified);
  assertLabels(name, verified.stdout, labels);
}

async function removeResource(
  runner: StreamingCommandRunner,
  kind: "network" | "volume",
  name: string,
  labels: readonly string[],
  connectedContainer?: string
): Promise<void> {
  const inspected = await runner.run("docker", [kind, "inspect", name, "--format", inspectVolumeLabels]);
  if (inspected.exitCode !== 0) {
    if (isMissing(inspected.stderr, kind, name)) return;
    throw commandError(`inspect recommended agent ${kind}`, inspected);
  }
  assertLabels(name, inspected.stdout, labels);
  if (kind === "network" && connectedContainer !== undefined) {
    const disconnected = await runner.run("docker", ["network", "disconnect", "--force", name, connectedContainer]);
    if (disconnected.exitCode !== 0 && !disconnected.stderr.includes("is not connected to network")) {
      throw commandError("disconnect trusted workspace relay from recommended agent network", disconnected);
    }
  }
  const removed = await runner.run("docker", [kind, "rm", name]);
  if (removed.exitCode !== 0 && !isMissing(removed.stderr, kind, name)) {
    throw commandError(`remove recommended agent ${kind}`, removed);
  }
}

async function connectOuter(runner: StreamingCommandRunner, network: string, containerId: string): Promise<void> {
  const connected = await runner.run("docker", ["network", "connect", "--alias", "dim-workspace", network, containerId]);
  if (connected.exitCode !== 0 && !connected.stderr.includes("already exists")) {
    throw commandError("connect trusted workspace relay to recommended agent network", connected);
  }
}

async function resolveImage(runner: StreamingCommandRunner, image: string): Promise<string> {
  const result = await runner.run("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  const id = result.stdout.trim();
  if (result.exitCode !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) throw commandError("resolve recommended agent image", result);
  return id;
}

function assertLabels(name: string, raw: string, expected: readonly string[]): void {
  let labels: unknown;
  try { labels = JSON.parse(raw); } catch { throw new UserError(`Docker resource '${name}' conflicts with DIM ownership`); }
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)
    || expected.some((label) => Reflect.get(labels, label.slice(0, label.indexOf("="))) !== label.slice(label.indexOf("=") + 1))) {
    throw new UserError(`Docker resource '${name}' conflicts with DIM ownership`);
  }
}

function isMissing(stderr: string, kind: "container" | "network" | "volume", name: string): boolean {
  const diagnostic = stderr.trim().toLowerCase();
  if (kind === "volume" && diagnostic === `error response from daemon: get ${name}: no such volume`.toLowerCase()) return true;
  return diagnostic.includes(`no such ${kind}: ${name}`.toLowerCase()) || diagnostic.includes(`${name} not found`.toLowerCase());
}

function commandError(action: string, result: Pick<CommandResult, "stderr" | "stdout">): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}
