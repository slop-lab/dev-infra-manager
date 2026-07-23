import path from "node:path";

export interface WorkspaceOptions {
  name: string;
  workspace: string;
  stateRoot: string;
  image: string;
  cpus: string;
  memory: string;
  pids: string;
  runtime: string;
  timeoutSeconds: number;
}

export function statePaths(options: WorkspaceOptions) {
  const root = path.join(options.stateRoot, "codex-workspaces", options.name);
  return {
    root,
    home: path.join(root, "home"),
    docker: path.join(root, "inner-docker")
  };
}

export function containerName(name: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(name)) {
    throw new Error("workspace name must match [a-z0-9][a-z0-9_.-]{0,47}");
  }
  return `dim-codex-${name}`;
}

export function dockerExecArgs(name: string, command: string[], interactive: boolean): string[] {
  const args = [
    "exec",
    "--user", "agent",
    "--env", "HOME=/home/agent",
    "--env", "CODEX_HOME=/home/agent/.codex"
  ];
  if (interactive) args.push("--interactive", "--tty");
  args.push(containerName(name), ...command);
  return args;
}

export function canEnterRunningContainer(action: string): boolean {
  return action === "shell" || action === "login" || action === "run";
}

export function dockerStartArgs(options: WorkspaceOptions): string[] {
  const args = dockerRunArgs(options, ["sleep", "infinity"], false);
  args.splice(1, 0, "--detach");
  return args;
}

export interface ResourceUpdateSelection {
  cpus: boolean;
  memory: boolean;
  pids: boolean;
}

export function dockerUpdateArgs(options: WorkspaceOptions, selection: ResourceUpdateSelection): string[] {
  const args = ["update"];
  if (selection.cpus) args.push("--cpus", options.cpus);
  if (selection.memory) args.push("--memory", options.memory, "--memory-swap", options.memory);
  if (selection.pids) args.push("--pids-limit", options.pids);
  args.push(containerName(options.name));
  return args;
}

export function dockerRunArgs(
  options: WorkspaceOptions,
  command: string[],
  interactive: boolean
): string[] {
  const state = statePaths(options);
  const args = [
    "run", "--rm", "--name", containerName(options.name),
    "--runtime", options.runtime,
    "--cpus", options.cpus,
    "--memory", options.memory,
    "--memory-swap", options.memory,
    "--pids-limit", options.pids,
    "--mount", `type=bind,source=${path.resolve(options.workspace)},target=/workspace`,
    "--mount", `type=bind,source=${state.home},target=/home/agent`,
    "--mount", `type=bind,source=${state.docker},target=/var/lib/docker`,
    "--workdir", "/workspace",
    "--env", "CODEX_HOME=/home/agent/.codex",
    "--env", "HOME=/home/agent"
  ];
  if (interactive) args.push("--interactive", "--tty");
  args.push(options.image, ...command);
  return args;
}

export function timedCommand(options: WorkspaceOptions, dockerArgs: string[]): [string, string[]] {
  if (options.timeoutSeconds <= 0) return ["docker", dockerArgs];
  return ["timeout", ["--foreground", "--kill-after=15s", `${options.timeoutSeconds}s`, "docker", ...dockerArgs]];
}
