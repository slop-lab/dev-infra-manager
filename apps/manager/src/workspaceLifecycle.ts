import { UserError } from "./errors.js";
import { ensureGitea, giteaNestedBaseUrl, GITEA_NETWORK } from "./gitea.js";
import { LifecycleState, validateLifecycleName } from "./lifecycleState.js";
import type { GiteaCredentials, LifecycleOptions, RepoRecord, WorkspaceRecord } from "./lifecycleTypes.js";
import type { StreamingCommandRunner } from "./types.js";

export interface WorkspaceGitEnvironment {
  username: string;
  token: string;
  userName: string;
  userEmail: string;
}

export interface WorkspaceCommandInput {
  name: string;
  command: string[];
  interactive: boolean;
}

export function validateWorkspaceProfiles(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value) || value.includes(",")) {
      throw new UserError(`workspace profile '${value}' must match [a-z0-9][a-z0-9_.-]{0,63}`);
    }
    if (seen.has(value)) throw new UserError(`workspace profile '${value}' is duplicated`);
    seen.add(value);
  }
  return [...seen];
}

export async function createWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: {
    project: string;
    name: string;
    profiles: string[];
    gitUserName?: string;
    gitUserEmail?: string;
  }
): Promise<WorkspaceRecord> {
  const project = validateLifecycleName(input.project, "project");
  const name = validateLifecycleName(input.name, "workspace");
  const profiles = validateWorkspaceProfiles(input.profiles);
  const state = new LifecycleState(options.stateRoot);
  const repo = await readyProject(state, project);
  const now = new Date().toISOString();
  const gitUserName = input.gitUserName ?? process.env.DIM_GIT_USER_NAME ?? `dim/${name}`;
  const gitUserEmail = input.gitUserEmail ?? process.env.DIM_GIT_USER_EMAIL ?? `${name}@dim.invalid`;
  let record: WorkspaceRecord;

  try {
    record = await state.readWorkspace(name);
    if (record.project !== project) {
      throw new UserError(`workspace '${name}' is already bound to project '${record.project}'`);
    }
    if (record.profiles.join("\0") !== profiles.join("\0")) {
      throw new UserError(`workspace '${name}' already exists with different profiles; use workspace update`);
    }
  } catch (error) {
    if (!(error instanceof UserError) || !error.message.includes("not found")) throw error;
    record = {
      name,
      project,
      projectPath: "/workspace/project",
      phase: "creating",
      profiles,
      composeProjectName: `dim-${name}`,
      containerName: `dim-ws-${name}`,
      networkName: GITEA_NETWORK,
      dockerVolumeName: `dim-ws-${name}-docker`,
      routes: [],
      gitUserName,
      gitUserEmail,
      gitBaseUrl: "http://dim-gitea:3000",
      createdAt: now,
      updatedAt: now
    };
    await state.claimWorkspace(record);
  }

  const release = await state.acquireWorkspaceSetupLock(name);
  try {
    const reconciled = await reconcileProject(runner, options, state, record, repo);
    return await setupWorkspaceLocked(runner, state, reconciled);
  } finally {
    await release();
  }
}

export async function runWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: WorkspaceCommandInput
): Promise<number> {
  const record = await runnableWorkspace(runner, options, input.name);
  if (input.command.length === 0) throw new UserError("workspace run requires a task");
  const hasEntrypoint = await projectFileExists(runner, record, ".dim/entrypoint.sh");
  const command = hasEntrypoint
    ? ["sh", ".dim/entrypoint.sh", ...input.command]
    : input.command;
  return streamProjectCommand(runner, record, command, input.interactive);
}

export async function execWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: WorkspaceCommandInput
): Promise<number> {
  const record = await showWorkspace(options, input.name);
  await assertContainerRunning(runner, record);
  if (input.command.length === 0) throw new UserError("workspace exec requires a command");
  return streamProjectCommand(runner, record, input.command, input.interactive);
}

export async function setupWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  profilesChanged = false
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    return await setupWorkspaceLocked(runner, state, await state.readWorkspace(workspaceName), profilesChanged);
  } finally {
    await release();
  }
}

async function setupWorkspaceLocked(
  runner: StreamingCommandRunner,
  state: LifecycleState,
  initialRecord: WorkspaceRecord,
  profilesChanged = false
): Promise<WorkspaceRecord> {
  let record = initialRecord;
  await assertContainerRunning(runner, record);
  const startedAt = new Date().toISOString();
  record = {
    ...record,
    phase: "setting-up",
    lastSetup: { startedAt },
    updatedAt: startedAt
  };
  delete record.error;
  await state.writeWorkspace(record);

  const exitCode = await runProjectSetup(runner, record, profilesChanged);
  const completedAt = new Date().toISOString();
  if (exitCode !== 0) {
    const setupError = `project setup exited with ${exitCode}`;
    record = {
      ...record,
      phase: "setup-error",
      lastSetup: { startedAt, completedAt, exitCode, error: setupError },
      updatedAt: completedAt,
      error: setupError
    };
    await state.writeWorkspace(record);
    throw new UserError(setupError);
  }
  record = {
    ...record,
    phase: "ready",
    lastSetup: { startedAt, completedAt, exitCode: 0 },
    updatedAt: completedAt
  };
  delete record.error;
  await state.writeWorkspace(record);
  return record;
}

export async function updateWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string,
  profiles?: string[]
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  let record = await state.readWorkspace(workspaceName);
  const oldProfiles = record.profiles;
  const nextProfiles = profiles === undefined ? oldProfiles : validateWorkspaceProfiles(profiles);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    await assertContainerRunning(runner, record);
    const status = await projectCommand(runner, record, ["git", "status", "--porcelain"]);
    if (status.exitCode !== 0) throw commandError("inspect project Git status", status);
    if (status.stdout.trim()) throw new UserError(`workspace '${workspaceName}' has uncommitted project changes`);
    const pull = await projectCommand(runner, record, ["git", "pull", "--ff-only"]);
    if (pull.exitCode !== 0) throw commandError("fast-forward project repository", pull);
    record = { ...record, profiles: nextProfiles, updatedAt: new Date().toISOString() };
    await state.writeWorkspace(record);
    return await setupWorkspaceLocked(
      runner,
      state,
      record,
      oldProfiles.join("\0") !== nextProfiles.join("\0")
    );
  } finally {
    await release();
  }
}

export async function startWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    const record = await state.readWorkspace(workspaceName);
    const repo = await readyProject(state, record.project);
    const reconciled = await reconcileProject(runner, options, state, record, repo);
    return await setupWorkspaceLocked(runner, state, reconciled);
  } finally {
    await release();
  }
}

export async function showWorkspace(options: LifecycleOptions, name: string): Promise<WorkspaceRecord> {
  return new LifecycleState(options.stateRoot).readWorkspace(validateLifecycleName(name, "workspace"));
}

export async function stopWorkspace(runner: StreamingCommandRunner, options: LifecycleOptions, name: string): Promise<void> {
  const state = new LifecycleState(options.stateRoot);
  const workspaceName = validateLifecycleName(name, "workspace");
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    let record = await state.readWorkspace(workspaceName);
    const inspect = await runner.run("docker", ["container", "inspect", record.containerName, "--format", "{{.State.Running}}"]);
    if (inspect.exitCode === 0 && inspect.stdout.trim() === "true") {
      const exitCode = await runner.runStreaming("docker", ["stop", record.containerName]);
      if (exitCode !== 0) throw new UserError(`failed to stop workspace '${name}'`);
    }
    record = { ...record, phase: "stopped", updatedAt: new Date().toISOString() };
    delete record.error;
    await state.writeWorkspace(record);
  } finally {
    await release();
  }
}

export async function discardWorkspace(runner: StreamingCommandRunner, options: LifecycleOptions, name: string): Promise<void> {
  const workspaceName = validateLifecycleName(name, "workspace");
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireWorkspaceSetupLock(workspaceName);
  try {
    const record = await state.readWorkspace(workspaceName);
    const inspect = await runner.run("docker", ["container", "inspect", record.containerName, "--format", "{{.State.Running}}"]);
    if (inspect.exitCode === 0) {
      if (inspect.stdout.trim() !== "true") {
        await runner.run("docker", ["start", record.containerName]);
        await waitForInnerDocker(runner, record.containerName);
      }
      await runProjectTeardown(runner, record);
    }
    const removed = await runner.run("docker", ["container", "rm", "--force", record.containerName]);
    if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) {
      throw new UserError(`failed to remove workspace container: ${removed.stderr.trim()}`);
    }
    const volume = await runner.run("docker", ["volume", "rm", record.dockerVolumeName]);
    if (volume.exitCode !== 0 && !volume.stderr.includes("No such volume")) {
      throw new UserError(`failed to remove workspace Docker volume: ${volume.stderr.trim()}`);
    }
    await state.removeWorkspace(workspaceName);
  } finally {
    await release();
  }
}

async function reconcileProject(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  state: LifecycleState,
  initialRecord: WorkspaceRecord,
  repo: RepoRecord
): Promise<WorkspaceRecord> {
  const release = await state.acquireWorkspaceLock(initialRecord.name);
  let record = await state.readWorkspace(initialRecord.name);
  try {
    try {
      const credentials = await ensureGitea(runner, options);
      const gitBaseUrl = await giteaNestedBaseUrl(runner);
      record = { ...record, gitBaseUrl };
      await state.writeWorkspace(record);
      await reconcileContainer(runner, options, record, gitEnvironment(record, credentials));
      await ensureClone(runner, record, repo.cloneUrl);
      record = { ...record, updatedAt: new Date().toISOString() };
      await state.writeWorkspace(record);
      return record;
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
    await release();
  }
}

async function readyProject(state: LifecycleState, project: string): Promise<RepoRecord> {
  const repo = await state.readRepo(project);
  if (repo.phase !== "ready") throw new UserError(`project '${project}' is not ready (phase: ${repo.phase})`);
  return repo;
}

function gitEnvironment(record: WorkspaceRecord, credentials: GiteaCredentials): WorkspaceGitEnvironment {
  return {
    username: credentials.writerUsername,
    token: credentials.writerPassword,
    userName: record.gitUserName,
    userEmail: record.gitUserEmail
  };
}

async function runnableWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  name: string
): Promise<WorkspaceRecord> {
  const record = await showWorkspace(options, name);
  if (record.phase !== "ready") {
    throw new UserError(`workspace '${record.name}' is not ready (phase: ${record.phase}); run workspace setup`);
  }
  await assertContainerRunning(runner, record);
  return record;
}

async function assertContainerRunning(runner: StreamingCommandRunner, record: WorkspaceRecord): Promise<void> {
  const inspect = await runner.run("docker", ["container", "inspect", record.containerName, "--format", "{{.State.Running}}"]);
  if (inspect.exitCode !== 0 || inspect.stdout.trim() !== "true") {
    throw new UserError(`workspace '${record.name}' is stopped; run workspace start`);
  }
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
    "--format",
    "{{index .Config.Labels \"dim.managed\"}}|{{index .Config.Labels \"dim.workspace\"}}|{{index .Config.Labels \"dim.project\"}}|{{index .Config.Labels \"dim.repo\"}}|{{.State.Running}}"
  ];
  let inspect = await runner.run("docker", inspectArgs);
  if (inspect.exitCode !== 0) {
    const created = await runner.run("docker", workspaceContainerArgs(options, record, git));
    if (created.exitCode !== 0) {
      inspect = await runner.run("docker", inspectArgs);
      if (inspect.exitCode !== 0) {
        throw new UserError(`failed to create workspace container: ${created.stderr.trim()}`);
      }
    } else {
      inspect = await runner.run("docker", inspectArgs);
    }
  }
  const [managed, workspace, projectLabel, repoLabel, running] = inspect.stdout.trim().split("|");
  if (
    managed !== "true"
    || workspace !== record.name
    || (projectLabel !== record.project && repoLabel !== record.project)
  ) {
    throw new UserError(`Docker resource '${record.containerName}' conflicts with workspace '${record.name}'`);
  }
  if (running !== "true") {
    const started = await runner.run("docker", ["start", record.containerName]);
    if (started.exitCode !== 0) throw new UserError(`failed to start workspace '${record.name}'`);
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
    "--label", `dim.project=${record.project}`,
    "--label", `dim.repo=${record.project}`,
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
  const existing = await runner.run("docker", [
    "exec", "--user", "agent", record.containerName,
    "git", "-C", record.projectPath, "rev-parse", "--git-dir"
  ]);
  if (existing.exitCode === 0) return;
  const parent = record.projectPath.slice(0, record.projectPath.lastIndexOf("/")) || "/workspace";
  const directory = await runner.run("docker", ["exec", "--user", "agent", record.containerName, "mkdir", "-p", parent]);
  if (directory.exitCode !== 0) throw commandError("prepare project directory", directory);
  const clone = await runner.run("docker", [
    "exec", "--user", "agent", record.containerName,
    "git", "clone", cloneUrl, record.projectPath
  ]);
  if (clone.exitCode !== 0) throw commandError(`clone project '${record.project}'`, clone);
}

async function runProjectSetup(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  profilesChanged: boolean
): Promise<number> {
  const profileArgs = repeatedProfileArgs(record.profiles);
  if (await projectFileExists(runner, record, ".dim/setup.sh")) {
    return streamProjectCommand(runner, record, ["sh", ".dim/setup.sh", ...profileArgs], false);
  }
  if (!(await projectFileExists(runner, record, ".dim/docker-compose.yml"))) return 0;
  if (profilesChanged) {
    const down = await streamProjectCommand(runner, record, [
      "docker", "compose", "--project-name", record.composeProjectName,
      "--file", ".dim/docker-compose.yml", "--profile", "*",
      "down", "--remove-orphans"
    ], false);
    if (down !== 0) return down;
  }
  return streamProjectCommand(runner, record, [
    "docker", "compose", "--project-name", record.composeProjectName,
    "--file", ".dim/docker-compose.yml",
    ...composeProfileArgs(record.profiles),
    "up", "--detach", "--build"
  ], false);
}

async function runProjectTeardown(runner: StreamingCommandRunner, record: WorkspaceRecord): Promise<void> {
  if (await projectFileExists(runner, record, ".dim/teardown.sh")) {
    await streamProjectCommand(runner, record, ["sh", ".dim/teardown.sh", ...repeatedProfileArgs(record.profiles)], false);
    return;
  }
  if (await projectFileExists(runner, record, ".dim/docker-compose.yml")) {
    await streamProjectCommand(runner, record, [
      "docker", "compose", "--project-name", record.composeProjectName,
      "--file", ".dim/docker-compose.yml", "--profile", "*",
      "down", "--remove-orphans"
    ], false);
  }
}

function composeProfileArgs(profiles: string[]): string[] {
  return profiles.flatMap((profile) => ["--profile", profile]);
}

function repeatedProfileArgs(profiles: string[]): string[] {
  return composeProfileArgs(profiles);
}

function projectEnvironment(record: WorkspaceRecord): string[] {
  return [
    "--env", `DIM_PROJECT_ROOT=${record.projectPath}`,
    "--env", `DIM_WORKSPACE_NAME=${record.name}`,
    "--env", `COMPOSE_PROJECT_NAME=${record.composeProjectName}`,
    "--env", `COMPOSE_PROFILES=${record.profiles.join(",")}`,
    "--env", `DIM_GIT_BASE_URL=${record.gitBaseUrl}`
  ];
}

async function projectFileExists(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  relativePath: string
): Promise<boolean> {
  const result = await runner.run("docker", [
    "exec", "--user", "agent", "--workdir", record.projectPath,
    record.containerName, "test", "-f", relativePath
  ]);
  return result.exitCode === 0;
}

async function projectCommand(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  command: string[]
) {
  const args = [
    "exec", "--user", "agent", "--workdir", record.projectPath,
    ...projectEnvironment(record), record.containerName, ...command
  ];
  return runner.run("docker", args);
}

async function streamProjectCommand(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  command: string[],
  interactive: boolean
): Promise<number> {
  const args = [
    "exec", "--user", "agent", "--workdir", record.projectPath,
    ...projectEnvironment(record)
  ];
  if (interactive) args.push("--interactive", "--tty");
  args.push(record.containerName, ...command);
  return runner.runStreaming("docker", args);
}

function commandError(action: string, result: { stderr: string; stdout: string }): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}
