import { randomBytes } from "node:crypto";
import { UserError } from "./errors.js";
import { LifecycleState } from "./lifecycleState.js";
import type { GiteaCredentials, GiteaServiceRecord, LifecycleOptions } from "./lifecycleTypes.js";
import type { CommandRunner } from "./types.js";

export const GITEA_CONTAINER = "dim-gitea";
export const GITEA_NETWORK = "dim-control";
export const GITEA_VOLUME = "dim-gitea-data";
const CREDENTIAL_PATH = "/data/dim/credentials.json";

export async function ensureGitea(runner: CommandRunner, options: LifecycleOptions): Promise<GiteaCredentials> {
  const state = new LifecycleState(options.stateRoot);
  const now = new Date().toISOString();
  let record: GiteaServiceRecord;
  try {
    record = await state.readGiteaService();
    if (record.port !== options.giteaPort) {
      throw new UserError(`Gitea is already managed on port ${record.port}; requested ${options.giteaPort}`);
    }
  } catch (error) {
    if (!(error instanceof UserError) || !error.message.includes("not found")) throw error;
    record = {
      phase: "creating",
      containerName: GITEA_CONTAINER,
      networkName: GITEA_NETWORK,
      volumeName: GITEA_VOLUME,
      image: options.giteaImage,
      port: options.giteaPort,
      createdAt: now,
      updatedAt: now
    };
    try {
      await state.claimGiteaService(record);
    } catch (claimError) {
      if (!(claimError instanceof UserError) || !claimError.message.includes("already exists")) throw claimError;
      record = await state.readGiteaService();
    }
  }

  try {
    const credentials = await ensureGiteaResources(runner, options);
    record = { ...record, phase: "ready", updatedAt: new Date().toISOString() };
    delete record.error;
    await state.writeGiteaService(record);
    return credentials;
  } catch (error) {
    record = {
      ...record,
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    };
    await state.writeGiteaService(record);
    throw error;
  }
}

async function ensureGiteaResources(runner: CommandRunner, options: LifecycleOptions): Promise<GiteaCredentials> {
  await ensureResource(runner, ["network", "inspect", GITEA_NETWORK, "--format", "{{index .Labels \"dim.managed\"}}"], [
    "network", "create", "--label", "dim.managed=true", "--label", "dim.resource=network", GITEA_NETWORK
  ], GITEA_NETWORK);
  await ensureResource(runner, ["volume", "inspect", GITEA_VOLUME, "--format", "{{index .Labels \"dim.managed\"}}"], [
    "volume", "create", "--label", "dim.managed=true", "--label", "dim.resource=gitea-data", GITEA_VOLUME
  ], GITEA_VOLUME);

  const inspect = await runner.run("docker", [
    "container", "inspect", GITEA_CONTAINER,
    "--format", "{{index .Config.Labels \"dim.managed\"}}|{{.State.Running}}"
  ]);
  if (inspect.exitCode !== 0) {
    const created = await runner.run("docker", [
      "run", "--detach",
      "--name", GITEA_CONTAINER,
      "--restart", "unless-stopped",
      "--network", GITEA_NETWORK,
      "--network-alias", "dim-gitea",
      "--publish", `127.0.0.1:${options.giteaPort}:3000`,
      "--mount", `type=volume,source=${GITEA_VOLUME},target=/data`,
      "--label", "dim.managed=true",
      "--label", "dim.resource=gitea",
      "--env", "GITEA__database__DB_TYPE=sqlite3",
      "--env", "GITEA__server__DISABLE_SSH=true",
      "--env", `GITEA__server__ROOT_URL=http://127.0.0.1:${options.giteaPort}/`,
      "--env", "GITEA__service__DISABLE_REGISTRATION=true",
      "--env", "GITEA__security__INSTALL_LOCK=true",
      options.giteaImage
    ]);
    assertCommand(created, "start Gitea");
  } else {
    const [managed, running] = inspect.stdout.trim().split("|");
    if (managed !== "true") throw new UserError(`Docker resource '${GITEA_CONTAINER}' exists but is not managed by dim`);
    if (running === "true") {
      await waitForGitea(options.giteaPort);
      return ensureCredentials(runner, options);
    }
    assertCommand(await runner.run("docker", ["start", GITEA_CONTAINER]), "start existing Gitea");
  }

  await waitForGitea(options.giteaPort);
  return ensureCredentials(runner, options);
}

export function giteaInternalCloneUrl(owner: string, repo: string): string {
  return `http://dim-gitea:3000/${owner}/${repo}.git`;
}

export function giteaHostCloneUrl(options: LifecycleOptions, owner: string, repo: string): string {
  return `http://127.0.0.1:${options.giteaPort}/${owner}/${repo}.git`;
}

export async function giteaNestedBaseUrl(runner: CommandRunner): Promise<string> {
  const result = await runner.run("docker", [
    "container", "inspect", GITEA_CONTAINER,
    "--format", `{{with index .NetworkSettings.Networks "${GITEA_NETWORK}"}}{{.IPAddress}}{{end}}`
  ]);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new UserError(`Failed to resolve nested Gitea endpoint: ${(result.stderr || result.stdout).trim()}`);
  }
  return `http://${result.stdout.trim()}:3000`;
}

export async function giteaRequest(
  options: LifecycleOptions,
  credentials: GiteaCredentials,
  method: string,
  apiPath: string,
  body?: unknown
): Promise<Response> {
  const authorization = Buffer.from(`${credentials.adminUsername}:${credentials.adminPassword}`).toString("base64");
  return fetch(`http://127.0.0.1:${options.giteaPort}/api/v1${apiPath}`, {
    method,
    headers: {
      Authorization: `Basic ${authorization}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function ensureResource(runner: CommandRunner, inspectArgs: string[], createArgs: string[], name: string): Promise<void> {
  const inspected = await runner.run("docker", inspectArgs);
  if (inspected.exitCode === 0) {
    if (inspected.stdout.trim() !== "true") {
      throw new UserError(`Docker resource '${name}' exists but is not managed by dim`);
    }
    return;
  }
  assertCommand(await runner.run("docker", createArgs), `create Docker ${createArgs[0]}`);
}

async function waitForGitea(port: number): Promise<void> {
  let lastError = "not ready";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/healthz`);
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new UserError(`Gitea did not become ready: ${lastError}`);
}

async function ensureCredentials(runner: CommandRunner, options: LifecycleOptions): Promise<GiteaCredentials> {
  const existing = await runner.run("docker", ["exec", GITEA_CONTAINER, "cat", CREDENTIAL_PATH]);
  if (existing.exitCode === 0) {
    return JSON.parse(existing.stdout) as GiteaCredentials;
  }

  const credentials: GiteaCredentials = {
    adminUsername: options.giteaAdminUsername,
    adminPassword: process.env.DIM_GITEA_ADMIN_PASSWORD ?? randomBytes(24).toString("base64url"),
    writerUsername: options.gitUsername,
    writerPassword: process.env.DIM_GIT_TOKEN ?? randomBytes(24).toString("base64url")
  };
  await createUser(runner, credentials.adminUsername, credentials.adminPassword, true);
  await createUser(runner, credentials.writerUsername, credentials.writerPassword, false);
  const encoded = Buffer.from(JSON.stringify(credentials)).toString("base64");
  const stored = await runner.run("docker", [
    "exec", "--env", `DIM_CREDENTIALS=${encoded}`, GITEA_CONTAINER,
    "sh", "-c", `umask 077; mkdir -p /data/dim; printf %s "$DIM_CREDENTIALS" | base64 -d > ${CREDENTIAL_PATH}`
  ]);
  assertCommand(stored, "store Gitea workspace credentials");
  return credentials;
}

async function createUser(runner: CommandRunner, username: string, password: string, admin: boolean): Promise<void> {
  const args = [
    "exec", "--user", "git", GITEA_CONTAINER,
    "gitea", "admin", "user", "create",
    "--config", "/data/gitea/conf/app.ini",
    "--username", username,
    "--password", password,
    "--email", `${username}@dim.invalid`,
    "--must-change-password=false"
  ];
  if (admin) args.push("--admin");
  const result = await runner.run("docker", args);
  if (result.exitCode !== 0) {
    if (!`${result.stdout}\n${result.stderr}`.includes("already exists")) {
      assertCommand(result, `create Gitea user ${username}`);
    }
    const reset = await runner.run("docker", [
      "exec", "--user", "git", GITEA_CONTAINER,
      "gitea", "admin", "user", "change-password",
      "--config", "/data/gitea/conf/app.ini",
      "--username", username,
      "--password", password
    ]);
    assertCommand(reset, `recover Gitea user ${username}`);
  }
}

function assertCommand(result: { exitCode: number; stdout?: string; stderr: string }, action: string): void {
  if (result.exitCode !== 0) {
    throw new UserError(`Failed to ${action}: ${(result.stderr || result.stdout || "").trim()}`);
  }
}
