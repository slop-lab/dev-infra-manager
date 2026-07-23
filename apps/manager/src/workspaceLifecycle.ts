import { UserError } from "./errors.js";
import { ensureGitea, GITEA_NETWORK } from "./gitea.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";

export interface WorkspaceGitEnvironment {
  username: string;
  token: string;
  userName: string;
  userEmail: string;
}

export async function runWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: {
    repo: string;
    name: string;
    command: string[];
    gitUserName?: string;
    gitUserEmail?: string;
    interactive: boolean;
  }
): Promise<number> {
  const repoName = validateLifecycleName(input.repo, "repo");
  const workspaceName = validateLifecycleName(input.name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const repo = await state.readRepo(repoName);
  if (repo.phase !== "ready") {
    throw new UserError(`repo '${repoName}' is not ready (phase: ${repo.phase})`);
  }
  const credentials = await ensureGitea(runner, options);
  const now = new Date().toISOString();
  let record: WorkspaceRecord;
  try {
    record = await state.readWorkspace(workspaceName);
    if (record.repo !== repoName) {
      throw new UserError(`workspace '${workspaceName}' is already bound to repo '${record.repo}'`);
    }
  } catch (error) {
    if (!(error instanceof UserError) || !error.message.includes("not found")) throw error;
    record = {
      name: workspaceName,
      repo: repoName,
      phase: "creating",
      containerName: `dim-ws-${workspaceName}`,
      networkName: GITEA_NETWORK,
      dockerVolumeName: `dim-ws-${workspaceName}-docker`,
      routes: [],
      createdAt: now,
      updatedAt: now
    };
    try {
      await state.claimWorkspace(record);
    } catch (claimError) {
      if (!(claimError instanceof UserError) || !claimError.message.includes("already exists")) throw claimError;
      record = await state.readWorkspace(workspaceName);
      if (record.repo !== repoName) {
        throw new UserError(`workspace '${workspaceName}' is already bound to repo '${record.repo}'`);
      }
    }
  }

  const releaseLock = await state.acquireWorkspaceLock(workspaceName);
  try {
    try {
      record = await state.readWorkspace(workspaceName);
      await reconcileContainer(runner, options, record, {
        username: credentials.writerUsername,
        token: credentials.writerPassword,
        userName: input.gitUserName ?? process.env.DIM_GIT_USER_NAME ?? `dim/${workspaceName}`,
        userEmail: input.gitUserEmail ?? process.env.DIM_GIT_USER_EMAIL ?? `${workspaceName}@dim.invalid`
      });
      await ensureClone(runner, record, repo.cloneUrl);
      record = { ...record, phase: "ready", updatedAt: new Date().toISOString() };
      delete record.error;
      await state.writeWorkspace(record);
    } catch (error) {
      record = {
        ...record,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      };
      await state.writeWorkspace(record);
      throw error;
    }
  } finally {
    await releaseLock();
  }

  const command = input.command.length > 0 ? input.command : ["bash"];
  const args = ["exec", "--user", "agent", "--workdir", `/workspace/repos/${repoName}`];
  if (input.interactive) args.push("--interactive", "--tty");
  args.push(record.containerName, ...command);
  return runner.runStreaming("docker", args);
}

export async function showWorkspace(options: LifecycleOptions, name: string): Promise<WorkspaceRecord> {
  return new LifecycleState(options.stateRoot).readWorkspace(validateLifecycleName(name, "workspace"));
}

export async function stopWorkspace(runner: StreamingCommandRunner, options: LifecycleOptions, name: string): Promise<void> {
  const record = await showWorkspace(options, name);
  const inspect = await runner.run("docker", ["container", "inspect", record.containerName, "--format", "{{.State.Running}}"]);
  if (inspect.exitCode === 0 && inspect.stdout.trim() === "true") {
    const exitCode = await runner.runStreaming("docker", ["stop", record.containerName]);
    if (exitCode !== 0) throw new UserError(`failed to stop workspace '${name}'`);
  }
}

export async function discardWorkspace(runner: StreamingCommandRunner, options: LifecycleOptions, name: string): Promise<void> {
  const record = await showWorkspace(options, name);
  const removed = await runner.run("docker", ["container", "rm", "--force", record.containerName]);
  if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) {
    throw new UserError(`failed to remove workspace container: ${removed.stderr.trim()}`);
  }
  const volume = await runner.run("docker", ["volume", "rm", record.dockerVolumeName]);
  if (volume.exitCode !== 0 && !volume.stderr.includes("No such volume")) {
    throw new UserError(`failed to remove workspace Docker volume: ${volume.stderr.trim()}`);
  }
  await new LifecycleState(options.stateRoot).removeWorkspace(name);
}

async function reconcileContainer(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  record: WorkspaceRecord,
  git: WorkspaceGitEnvironment
): Promise<void> {
  await reconcileDockerVolume(runner, record);
  const inspectArgs = [
    "container", "inspect", record.containerName,
    "--format", "{{index .Config.Labels \"dim.managed\"}}|{{index .Config.Labels \"dim.workspace\"}}|{{index .Config.Labels \"dim.repo\"}}|{{.State.Running}}"
  ];
  let inspect = await runner.run("docker", inspectArgs);
  if (inspect.exitCode !== 0) {
    const args = workspaceContainerArgs(options, record, git);
    const created = await runner.run("docker", args);
    if (created.exitCode !== 0) {
      inspect = await runner.run("docker", inspectArgs);
      if (inspect.exitCode !== 0) {
        throw new UserError(`failed to create workspace container: ${created.stderr.trim()}`);
      }
    } else {
      inspect = await runner.run("docker", inspectArgs);
    }
  }
  const [managed, workspace, repo, running] = inspect.stdout.trim().split("|");
  if (managed !== "true" || workspace !== record.name || repo !== record.repo) {
    throw new UserError(`Docker resource '${record.containerName}' conflicts with workspace '${record.name}'`);
  }
  if (running !== "true") {
    const started = await runner.run("docker", ["start", record.containerName]);
    if (started.exitCode !== 0) throw new UserError(`failed to start workspace container: ${started.stderr.trim()}`);
  }
  await waitForInnerDocker(runner, record.containerName);
}

async function reconcileDockerVolume(runner: StreamingCommandRunner, record: WorkspaceRecord): Promise<void> {
  const inspectArgs = [
    "volume", "inspect", record.dockerVolumeName,
    "--format", "{{index .Labels \"dim.managed\"}}|{{index .Labels \"dim.workspace\"}}|{{index .Labels \"dim.resource\"}}"
  ];
  let inspect = await runner.run("docker", inspectArgs);
  if (inspect.exitCode !== 0) {
    const created = await runner.run("docker", [
      "volume", "create",
      "--label", "dim.managed=true",
      "--label", `dim.workspace=${record.name}`,
      "--label", "dim.resource=workspace-docker",
      record.dockerVolumeName
    ]);
    if (created.exitCode !== 0) {
      inspect = await runner.run("docker", inspectArgs);
      if (inspect.exitCode !== 0) throw new UserError(`failed to create workspace Docker volume: ${created.stderr.trim()}`);
    } else {
      inspect = await runner.run("docker", inspectArgs);
    }
  }
  if (inspect.stdout.trim() !== `true|${record.name}|workspace-docker`) {
    throw new UserError(`Docker volume '${record.dockerVolumeName}' conflicts with workspace '${record.name}'`);
  }
}

export function workspaceContainerArgs(
  options: LifecycleOptions,
  record: WorkspaceRecord,
  git: WorkspaceGitEnvironment
): string[] {
  const args = [
    "run", "--detach",
    "--name", record.containerName,
    "--network", record.networkName,
    "--runtime", options.workspaceRuntime,
    "--cpus", options.cpuCount,
    "--memory", options.memory,
    "--memory-swap", options.memory,
    "--pids-limit", options.pidsLimit,
    "--mount", `type=volume,source=${record.dockerVolumeName},target=/var/lib/docker`,
    "--label", "dim.managed=true",
    "--label", `dim.workspace=${record.name}`,
    "--label", `dim.repo=${record.repo}`,
    "--label", "dim.resource=workspace",
    "--env", `DIM_GIT_USERNAME=${git.username}`,
    "--env", `DIM_GIT_TOKEN=${git.token}`,
    "--env", `DIM_GIT_USER_NAME=${git.userName}`,
    "--env", `DIM_GIT_USER_EMAIL=${git.userEmail}`,
    "--env", "GIT_ASKPASS=/usr/local/bin/dim-git-askpass",
    "--env", "GIT_TERMINAL_PROMPT=0",
    "--env", "GIT_CONFIG_COUNT=2",
    "--env", "GIT_CONFIG_KEY_0=user.name",
    "--env", `GIT_CONFIG_VALUE_0=${git.userName}`,
    "--env", "GIT_CONFIG_KEY_1=user.email",
    "--env", `GIT_CONFIG_VALUE_1=${git.userEmail}`
  ];
  if (options.workspacePrivileged) args.push("--privileged");
  args.push(options.workspaceImage, "sleep", "infinity");
  return args;
}

async function waitForInnerDocker(runner: StreamingCommandRunner, containerName: string): Promise<void> {
  let lastError = "not ready";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await runner.run("docker", ["exec", "--user", "agent", containerName, "docker", "info"]);
    if (result.exitCode === 0) return;
    lastError = result.stderr.trim() || result.stdout.trim();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const logs = await runner.run("docker", ["exec", containerName, "cat", "/var/log/dockerd.log"]);
  throw new UserError(`inner Docker did not become ready: ${lastError}\n${logs.stdout || logs.stderr}`);
}

async function ensureClone(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  cloneUrl: string
): Promise<void> {
  const path = `/workspace/repos/${record.repo}`;
  const existing = await runner.run("docker", ["exec", "--user", "agent", record.containerName, "git", "-C", path, "rev-parse", "--git-dir"]);
  if (existing.exitCode === 0) return;
  const directory = await runner.run("docker", ["exec", "--user", "agent", record.containerName, "mkdir", "-p", "/workspace/repos"]);
  if (directory.exitCode !== 0) throw new UserError(`failed to prepare workspace repository directory: ${directory.stderr.trim()}`);
  const clone = await runner.run("docker", ["exec", "--user", "agent", record.containerName, "git", "clone", cloneUrl, path]);
  if (clone.exitCode !== 0) throw new UserError(`failed to clone repo '${record.repo}': ${clone.stderr.trim()}`);
}
