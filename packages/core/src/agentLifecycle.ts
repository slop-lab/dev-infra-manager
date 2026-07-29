import path from "node:path";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import { UserError } from "./errors.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";

interface AgentDefinition {
  buildContext: string;
  tasks: Record<string, string[]>;
}

const WORKSPACE_USER = "dim";

export async function reconcileAgent(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  record: WorkspaceRecord
): Promise<void> {
  const definition = await readAgentDefinition(runner, record);
  if (!definition) return;
  await reconcileDedicatedAgent(runner, options, record, definition);
}

export async function runAgentTask(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  record: WorkspaceRecord,
  task: string[],
  interactive: boolean
): Promise<number | undefined> {
  const definition = await readAgentDefinition(runner, record);
  if (!definition) return undefined;
  const command = definition.tasks[task[0] ?? ""];
  if (!command) throw new UserError(`unknown agent task: ${task[0] ?? ""}`);
  const args = ["exec", ...(interactive ? ["--interactive", "--tty"] : []), agentContainerName(record), ...command, ...task.slice(1)];
  return runner.runStreaming("docker", [...agentDockerArgs(options), ...args]);
}

export async function stopAgent(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  record: WorkspaceRecord
): Promise<void> {
  await agentDocker(runner, options, record, ["container", "stop", agentContainerName(record)]);
}

export async function removeAgent(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  record: WorkspaceRecord
): Promise<void> {
  await agentDocker(runner, options, record, ["container", "rm", "--force", agentContainerName(record)]);
  await agentDocker(runner, options, record, ["volume", "rm", agentCheckoutVolumeName(record)]);
  await agentDocker(runner, options, record, ["volume", "rm", agentDockerVolumeName(record)]);
}

async function reconcileDedicatedAgent(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  record: WorkspaceRecord,
  definition: AgentDefinition
): Promise<void> {
  await requireDedicatedDaemon(runner, options);
  const existing = await runner.run("docker", [
    ...agentDockerArgs(options), "container", "inspect",
    "--format", "{{index .Config.Labels \"dim.managed\"}}|{{index .Config.Labels \"dim.workspace\"}}|{{index .Config.Labels \"dim.resource\"}}",
    agentContainerName(record)
  ]);
  if (existing.exitCode === 0) {
    if (existing.stdout.trim() !== `true|${record.name}|agent`) {
      throw new UserError(`agent container '${agentContainerName(record)}' conflicts with workspace '${record.name}'`);
    }
    const removed = await runner.run("docker", [
      ...agentDockerArgs(options), "container", "rm", "--force", agentContainerName(record)
    ]);
    if (removed.exitCode !== 0) throw commandFailure("replace agent container", removed.stderr);
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), `dim-agent-${record.name}-`));
  try {
    const access = await readAgentAccess(runner, record);
    const copied = await runner.run("docker", [
      "cp", `${record.containerName}:${record.projectPath}/.`, temporary
    ]);
    if (copied.exitCode !== 0) throw commandFailure("copy agent checkout", copied.stderr);
    const context = await realpath(path.join(temporary, definition.buildContext));
    const root = `${await realpath(temporary)}${path.sep}`;
    if (!context.startsWith(root)) {
      throw new UserError(".dim/agent.json buildContext resolves outside the root repository");
    }
    const built = await runner.run("docker", [
      ...agentDockerArgs(options), "build", "--quiet", "--tag", agentImageName(record), context
    ]);
    if (built.exitCode !== 0) throw commandFailure("build agent image", built.stderr);
    let checkoutExisted = false;
    for (const volume of [agentCheckoutVolumeName(record), agentDockerVolumeName(record)]) {
      const before = await runner.run("docker", [
        ...agentDockerArgs(options), "volume", "inspect", volume
      ]);
      if (volume === agentCheckoutVolumeName(record)) checkoutExisted = before.exitCode === 0;
      const created = await runner.run("docker", [
        ...agentDockerArgs(options), "volume", "create",
        "--label", "dim.managed=true",
        "--label", `dim.workspace=${record.name}`,
        "--label", "dim.resource=agent",
        volume
      ]);
      if (created.exitCode !== 0) throw commandFailure(`create agent volume '${volume}'`, created.stderr);
      const inspected = await runner.run("docker", [
        ...agentDockerArgs(options), "volume", "inspect",
        "--format", "{{index .Labels \"dim.managed\"}}|{{index .Labels \"dim.workspace\"}}|{{index .Labels \"dim.resource\"}}",
        volume
      ]);
      if (inspected.exitCode !== 0 || inspected.stdout.trim() !== `true|${record.name}|agent`) {
        throw new UserError(`agent volume '${volume}' conflicts with workspace '${record.name}'`);
      }
    }
    const workspaceAddress = await runner.run("docker", [
      "inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", record.containerName
    ]);
    if (workspaceAddress.exitCode !== 0 || workspaceAddress.stdout.trim().length === 0) {
      throw commandFailure("resolve trusted workspace address", workspaceAddress.stderr);
    }
    const started = await runner.run("docker", agentContainerArgs(
      options,
      record,
      access,
      workspaceAddress.stdout.trim()
    ));
    if (started.exitCode !== 0) throw commandFailure("start dedicated agent", started.stderr);
    if (!checkoutExisted) {
      const seeded = await runner.run("docker", [
        ...agentDockerArgs(options), "cp", `${temporary}/.`, `${agentContainerName(record)}:/workspace`
      ]);
      if (seeded.exitCode !== 0) throw commandFailure("seed agent checkout", seeded.stderr);
    }
    const namespace = new URL(record.gitBaseUrl).pathname.replace(/^\/|\/$/g, "");
    const remote = `http://host.docker.internal:${options.giteaPort}/${namespace}/${record.rootRepositoryAlias}.git`;
    const trusted = await runner.run("docker", [
      ...agentDockerArgs(options), "exec", agentContainerName(record),
      "git", "config", "--global", "--add", "safe.directory", "/workspace"
    ]);
    if (trusted.exitCode !== 0) throw commandFailure("configure agent Git safe directory", trusted.stderr);
    const configured = await runner.run("docker", [
      ...agentDockerArgs(options), "exec", agentContainerName(record),
      "git", "-C", "/workspace", "remote", "set-url", "origin", remote
    ]);
    if (configured.exitCode !== 0) throw commandFailure("configure agent Git remote", configured.stderr);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function agentContainerArgs(
  options: LifecycleOptions,
  record: WorkspaceRecord,
  access: { name: string; email: string; username: string; token: string },
  workspaceAddress: string
): string[] {
  return [
      ...agentDockerArgs(options), "run", "--detach",
      "--name", agentContainerName(record),
      "--runtime", "sysbox-runc",
      "--network", record.networkName,
      "--cpus", record.cpuCount,
      "--memory", record.memory,
      "--memory-swap", record.memory,
      "--pids-limit", record.pidsLimit,
      "--add-host", "host.docker.internal:host-gateway",
      "--add-host", `project.internal:${workspaceAddress}`,
      "--mount", `type=volume,source=${agentCheckoutVolumeName(record)},target=/workspace`,
      "--mount", `type=volume,source=${agentDockerVolumeName(record)},target=/var/lib/docker`,
      "--workdir", "/workspace",
      "--label", "dim.managed=true",
      "--label", `dim.workspace=${record.name}`,
      "--label", "dim.resource=agent",
      "--env", `DIM_GIT_USERNAME=${access.username}`,
      "--env", `DIM_GIT_TOKEN=${access.token}`,
      "--env", "GIT_TERMINAL_PROMPT=0",
      "--env", "GIT_CONFIG_COUNT=1",
      "--env", "GIT_CONFIG_KEY_0=credential.helper",
      "--env", "GIT_CONFIG_VALUE_0=!f() { echo username=$DIM_GIT_USERNAME; echo password=$DIM_GIT_TOKEN; }; f",
      "--env", `GIT_AUTHOR_NAME=${access.name}`,
      "--env", `GIT_AUTHOR_EMAIL=${access.email}`,
      "--env", `GIT_COMMITTER_NAME=${access.name}`,
      "--env", `GIT_COMMITTER_EMAIL=${access.email}`,
      agentImageName(record)
  ];
}

async function readAgentAccess(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<{ name: string; email: string; username: string; token: string }> {
  const result = await runner.run("docker", [
    "exec", "--user", WORKSPACE_USER, record.containerName,
    "sh", "-c",
    ". /tmp/dim-host-inputs.env && printf '%s\\n%s\\n%s\\n%s\\n' \"$GIT_AUTHOR_NAME\" \"$GIT_AUTHOR_EMAIL\" \"$DIM_GIT_USERNAME\" \"$DIM_GIT_TOKEN\""
  ]);
  const [name, email, username, token] = result.stdout.split("\n");
  if (result.exitCode !== 0 || !name || !email || !username || !token) {
    throw new UserError("trusted workspace did not provide agent Git identity and managed credentials");
  }
  return { name, email, username, token };
}

async function readAgentDefinition(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<AgentDefinition | undefined> {
  const result = await runner.run("docker", [
    "exec", "--user", WORKSPACE_USER, "--workdir", record.projectPath,
    record.containerName, "cat", ".dim/agent.json"
  ]);
  if (result.exitCode !== 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new UserError(".dim/agent.json must contain valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError(".dim/agent.json must be an object");
  }
  const candidate = value as { buildContext?: unknown; tasks?: unknown };
  if (
    typeof candidate.buildContext !== "string"
    || path.isAbsolute(candidate.buildContext)
    || candidate.buildContext.split("/").includes("..")
  ) {
    throw new UserError(".dim/agent.json buildContext must be a relative path within the root repository");
  }
  if (!candidate.tasks || typeof candidate.tasks !== "object" || Array.isArray(candidate.tasks)) {
    throw new UserError(".dim/agent.json tasks must be an object");
  }
  const tasks: Record<string, string[]> = {};
  for (const [name, command] of Object.entries(candidate.tasks)) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name) || !Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== "string")) {
      throw new UserError(`.dim/agent.json task '${name}' must be a non-empty array of strings`);
    }
    tasks[name] = command as string[];
  }
  return { buildContext: candidate.buildContext, tasks };
}

async function requireDedicatedDaemon(runner: StreamingCommandRunner, options: LifecycleOptions): Promise<void> {
  const result = await runner.run("docker", [...agentDockerArgs(options), "info", "--format", "{{json .Runtimes}}"]);
  if (result.exitCode !== 0) {
    throw new UserError(`DIM agent Docker daemon is not reachable at ${options.agentDockerSocketPath}`);
  }
  if (!result.stdout.includes("\"sysbox-runc\"")) {
    throw new UserError("DIM agent Docker daemon does not have sysbox-runc registered");
  }
}

async function agentDocker(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  record: WorkspaceRecord,
  args: string[]
) {
  return runner.run("docker", [...agentDockerArgs(options), ...args]);
}

function agentDockerArgs(options: LifecycleOptions): string[] {
  return ["--host", `unix://${options.agentDockerSocketPath}`];
}

function agentContainerName(record: WorkspaceRecord): string {
  return record.agentContainerName ?? `dim-agent-${record.name}`;
}

function agentCheckoutVolumeName(record: WorkspaceRecord): string {
  return record.agentCheckoutVolumeName ?? `dim-agent-${record.name}-checkout`;
}

function agentDockerVolumeName(record: WorkspaceRecord): string {
  return record.agentDockerVolumeName ?? `dim-agent-${record.name}-docker`;
}

function agentImageName(record: WorkspaceRecord): string {
  return record.agentImageName ?? `dim-agent-${record.name}:latest`;
}

function commandFailure(action: string, stderr: string): UserError {
  return new UserError(`${action} failed: ${stderr.trim() || "command failed"}`);
}
