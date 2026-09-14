import { stat } from "node:fs/promises";
import { UserError } from "./errors.js";
import type { WorkspaceRecord } from "./lifecycleTypes.js";
import type { CommandResult, StreamingCommandRunner } from "./types.js";
import {
  PROJECT_COMPOSE_NAME,
  PROJECT_ROOT_SNAPSHOTS,
  WORKSPACE_USER
} from "./workspaceLifecycleTypes.js";

const HOST_INPUT_HELPER = `#!/usr/bin/env sh
set -eu
provider="\${1:?host input provider is required}"
key="\${2:?host input key is required}"
parameters="\${3-}"
: "\${DIM_CONTROLLER_SOCKET:?DIM_CONTROLLER_SOCKET is required}"
: "\${DIM_CONTROLLER_TOKEN:?DIM_CONTROLLER_TOKEN is required}"
if [ "$#" -ge 3 ]; then
  body="$(jq -cn --arg key "$key" --arg parameters "$parameters" '{key: $key, parameters: $parameters}')"
else
  body="$(jq -cn --arg key "$key" '{key: $key}')"
fi
curl --fail --silent --show-error \\
  --unix-socket "$DIM_CONTROLLER_SOCKET" \\
  --header "Authorization: Bearer $DIM_CONTROLLER_TOKEN" \\
  --header "Content-Type: application/json" \\
  --data "$body" \\
  "http://dim-controller/api/host-inputs/$provider" |
  jq -er '.value'
`;

export async function installHostInputHelper(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord
): Promise<void> {
  const encoded = Buffer.from(HOST_INPUT_HELPER).toString("base64");
  const result = await runner.run("docker", [
    "exec", "--user", "root",
    "--env", `DIM_HOST_INPUT_HELPER_B64=${encoded}`,
    record.containerName,
    "sh", "-c",
    "printf %s \"$DIM_HOST_INPUT_HELPER_B64\" | base64 -d > /usr/local/bin/dim-host-input && chmod 0755 /usr/local/bin/dim-host-input"
  ]);
  if (result.exitCode !== 0) throw commandError("install host input helper", result);
}

export async function runProjectSetup(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  profilesChanged: boolean,
  forceRecreate: boolean
): Promise<number> {
  const engine = nestedEngine(record);
  const profileArgs = repeatedProfileArgs(record.profiles);
  const root = lifecycleRoot(record);
  if (await lifecycleFileExists(runner, record, ".dim/setup.sh")) {
    return streamLifecycleCommand(runner, record, ["sh", `${root}/.dim/setup.sh`, ...profileArgs], false);
  }
  if (!(await lifecycleFileExists(runner, record, ".dim/docker-compose.yml"))) return 0;
  if (profilesChanged) {
    const down = await streamLifecycleCommand(runner, record, [
      engine, "compose", "--project-name", PROJECT_COMPOSE_NAME,
      "--file", `${root}/.dim/docker-compose.yml`, "--profile", "*",
      "down", "--remove-orphans"
    ], false);
    if (down !== 0) return down;
  }
  return streamLifecycleCommand(runner, record, [
    engine, "compose", "--project-name", PROJECT_COMPOSE_NAME,
    "--file", `${root}/.dim/docker-compose.yml`,
    ...composeProfileArgs(record.profiles),
    "up", "--detach", "--build", ...(forceRecreate ? ["--force-recreate"] : [])
  ], false);
}

export async function runProjectTeardown(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  keepVolume: boolean
): Promise<void> {
  await assertRootSnapshot(record);
  const root = lifecycleRoot(record);
  if (await lifecycleFileExists(runner, record, ".dim/teardown.sh")) {
    const exitCode = await streamLifecycleCommand(runner, record, [
      "env", `DIM_WORKSPACE_DISCARD_KEEP_VOLUME=${keepVolume ? "1" : "0"}`,
      "sh", `${root}/.dim/teardown.sh`, ...repeatedProfileArgs(record.profiles)
    ], false);
    if (exitCode !== 0) throw new UserError(`project teardown exited with ${exitCode}`);
    return;
  }
  if (await lifecycleFileExists(runner, record, ".dim/docker-compose.yml")) {
    const exitCode = await streamLifecycleCommand(runner, record, [
      nestedEngine(record), "compose", "--project-name", PROJECT_COMPOSE_NAME,
      "--file", `${root}/.dim/docker-compose.yml`, "--profile", "*",
      "down", "--remove-orphans"
    ], false);
    if (exitCode !== 0) throw new UserError(`project teardown exited with ${exitCode}`);
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
    "--env", `DIM_PROJECT_ID=${record.projectId}`,
    "--env", `DIM_PROJECT_NAME=${record.projectName}`,
    "--env", `DIM_PROJECT_ROOT=${record.projectPath}`,
    "--env", `DIM_PROJECT_MANIFEST=${record.projectManifestPath}`,
    "--env", `DIM_WORKSPACE_NAME=${record.name}`,
    "--env", `COMPOSE_PROJECT_NAME=${PROJECT_COMPOSE_NAME}`,
    "--env", `DIM_WORKSPACE_BACKEND=${record.runtimeBackend}`,
    "--env", `DIM_WORKSPACE_KVM=${record.kvm ? "1" : "0"}`,
    "--env", `DIM_NESTED_ENGINE=${nestedEngine(record)}`,
    "--env", `COMPOSE_PROFILES=${record.profiles.join(",")}`,
    "--env", `DIM_GIT_BASE_URL=${record.gitBaseUrl}`
  ];
}

export function rootBranch(ref: string): string {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) throw new UserError(`workspace root ref '${ref}' is not a branch`);
  return ref.slice(prefix.length);
}

function nestedEngine(_record: WorkspaceRecord): "docker" {
  return "docker";
}

export async function lifecycleFileExists(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  relativePath: string
): Promise<boolean> {
  const result = await runner.run("docker", [
    "exec", "--user", WORKSPACE_USER, "--workdir", lifecycleRoot(record),
    record.containerName, "test", "-f", relativePath
  ]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw commandError(`probe lifecycle file '${relativePath}' (exit code ${result.exitCode})`, result);
}

export function lifecycleRoot(record: WorkspaceRecord): string {
  return `${PROJECT_ROOT_SNAPSHOTS}/${record.rootCommit}`;
}

export async function assertRootSnapshot(record: WorkspaceRecord): Promise<void> {
  try {
    const snapshot = await stat(record.rootSnapshotPath);
    if (snapshot.isDirectory()) return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  throw new UserError(
    `workspace '${record.name}' protected root snapshot '${record.rootCommit}' is missing; recreate the workspace`
  );
}

export async function projectCommand(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  command: string[]
): Promise<CommandResult> {
  const args = [
    "exec", "--user", WORKSPACE_USER, "--workdir", record.projectPath,
    ...projectEnvironment(record), record.containerName, ...command
  ];
  return runner.run("docker", args);
}

export async function streamProjectCommand(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  command: string[],
  tty: boolean,
  attachStdin = false
): Promise<number> {
  const args = [
    "exec", "--user", WORKSPACE_USER, "--workdir", record.projectPath,
    ...projectEnvironment(record)
  ];
  if (attachStdin) args.push("--interactive");
  if (tty) args.push("--tty");
  args.push(record.containerName, ...command);
  return runner.runStreaming("docker", args, { terminal: tty });
}

export async function streamLifecycleCommand(
  runner: StreamingCommandRunner,
  record: WorkspaceRecord,
  command: string[],
  tty: boolean,
  attachStdin = false
): Promise<number> {
  const args = [
    "exec", "--user", WORKSPACE_USER, "--workdir", lifecycleRoot(record),
    ...projectEnvironment(record)
  ];
  if (attachStdin) args.push("--interactive");
  if (tty) args.push("--tty");
  args.push(record.containerName, ...command);
  return runner.runStreaming("docker", args, { terminal: tty });
}

export function commandError(action: string, result: { stderr: string; stdout: string }): UserError {
  return new UserError(`failed to ${action}: ${(result.stderr || result.stdout).trim()}`);
}
