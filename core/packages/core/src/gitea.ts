import { lookup } from "node:dns/promises";
import { MissingRecordError, UserError } from "./errors.js";
import { ensureGiteaCredentials } from "./giteaCredentials.js";
import { externalGiteaConnection } from "./giteaExternalConnection.js";
import {
  giteaChangePasswordArgs,
  giteaContainerCreationArgs,
  ensureGiteaBaseResources,
  ensureGiteaOrganizationPolicy,
  giteaWebhookConfigArgs,
  GITEA_CONTAINER,
  GITEA_NETWORK,
  GITEA_VOLUME,
  inspectGiteaContainer
} from "./giteaContainer.js";
import { LifecycleState } from "./lifecycleState.js";
import type { GiteaConnection, GiteaServiceRecord, LifecycleOptions } from "./lifecycleTypes.js";
import type { CommandRunner } from "./types.js";

export { giteaChangePasswordArgs, giteaWebhookConfigArgs, GITEA_CONTAINER, GITEA_NETWORK, GITEA_VOLUME };
export type { GiteaConnection } from "./lifecycleTypes.js";

export async function ensureGitea(runner: CommandRunner, options: LifecycleOptions): Promise<GiteaConnection> {
  if (options.giteaConnection.kind === "external") {
    return externalGiteaConnection(options.giteaConnection.file);
  }
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireGiteaServiceLock();
  try {
    return await ensureGiteaLocked(runner, options, state);
  } finally {
    await release();
  }
}

async function ensureGiteaLocked(
  runner: CommandRunner,
  options: LifecycleOptions,
  state: LifecycleState
): Promise<GiteaConnection> {
  const now = new Date().toISOString();
  let record: GiteaServiceRecord;
  try {
    record = await state.readGiteaService();
    if (record.port !== options.giteaPort) {
      throw new UserError(`Gitea is already managed on port ${record.port}; requested ${options.giteaPort}`);
    }
  } catch (error) {
    if (!(error instanceof MissingRecordError)) throw error;
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
    await state.claimGiteaService(record);
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

export async function configureGiteaWebhookAllowedHosts(
  runner: CommandRunner,
  options: LifecycleOptions,
  hosts: string[]
): Promise<void> {
  if (options.giteaConnection.kind === "external") {
    await ensureGitea(runner, options);
    return;
  }
  const state = new LifecycleState(options.stateRoot);
  const release = await state.acquireGiteaServiceLock();
  try {
    await ensureGiteaLocked(runner, options, state);
    try {
      const container = await inspectGiteaContainer(runner);
      if (container === undefined) throw new UserError(`Docker resource '${GITEA_CONTAINER}' does not exist`);
      assertCommand(
        await runner.run("docker", giteaWebhookConfigArgs(container.id, hosts)),
        "configure Gitea webhook targets"
      );
      assertCommand(
        await runner.run("docker", ["restart", container.id]),
        "restart Gitea after webhook configuration"
      );
      await ensureGiteaOrganizationPolicy(runner, container.id);
      await readyGiteaConnection(runner, options, container.id);
      const record = await state.readGiteaService();
      const ready = { ...record, phase: "ready", updatedAt: new Date().toISOString() } satisfies GiteaServiceRecord;
      delete ready.error;
      await state.writeGiteaService(ready);
    } catch (error) {
      const record = await state.readGiteaService();
      await state.writeGiteaService({
        ...record,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString()
      });
      throw error;
    }
  } finally {
    await release();
  }
}

async function ensureGiteaResources(runner: CommandRunner, options: LifecycleOptions): Promise<GiteaConnection> {
  const container = await inspectGiteaContainer(runner);
  await ensureGiteaBaseResources(runner);
  let containerId: string;
  if (container === undefined) {
    const publishAddress = (await lookup(options.giteaHost)).address;
    const created = await runner.run(
      "docker",
      giteaContainerCreationArgs(options, publishAddress, giteaHostBaseUrl(options))
    );
    assertCommand(created, "start Gitea");
    containerId = created.stdout.trim();
    if (containerId.length === 0) throw new UserError("Failed to start Gitea: Docker returned no container ID");
  } else {
    containerId = container.id;
    if (!container.running) {
      assertCommand(await runner.run("docker", ["start", containerId]), "start existing Gitea");
    }
    await ensureGiteaOrganizationPolicy(runner, containerId);
  }

  return readyGiteaConnection(runner, options, containerId);
}

export function giteaInternalCloneUrl(connection: GiteaConnection, owner: string, repo: string): string {
  return `${connection.workspaceBaseUrl}/${owner}/${repo}.git`;
}

export function giteaHostCloneUrl(connection: GiteaConnection, owner: string, repo: string): string {
  return `${connection.hostBaseUrl}/${owner}/${repo}.git`;
}

export async function giteaNestedBaseUrl(runner: CommandRunner, connection: GiteaConnection): Promise<string> {
  if (connection.kind === "external") return connection.workspaceBaseUrl;
  const result = await runner.run("docker", [
    "container", "inspect", GITEA_CONTAINER,
    "--format", `{{with index .NetworkSettings.Networks "${GITEA_NETWORK}"}}{{.IPAddress}}{{end}}`
  ]);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new UserError(`Failed to resolve nested Gitea endpoint: ${(result.stderr || result.stdout).trim()}`);
  }
  return `http://${result.stdout.trim()}:3000`;
}

export async function giteaRunnerBaseUrl(runner: CommandRunner, connection: GiteaConnection): Promise<string> {
  return connection.kind === "external" ? connection.runnerBaseUrl : giteaNestedBaseUrl(runner, connection);
}

export async function giteaRequest(
  connection: GiteaConnection,
  method: string,
  apiPath: string,
  body?: unknown
): Promise<Response> {
  const url = giteaApiRequestUrl(connection.apiBaseUrl, apiPath);
  const authorization = Buffer.from(`${connection.adminUsername}:${connection.adminPassword}`).toString("base64");
  const response = await fetch(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Basic ${authorization}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (response.status >= 300 && response.status < 400) {
    throw new UserError("Gitea API redirects are not allowed");
  }
  return response;
}

function giteaApiRequestUrl(apiBaseUrl: string, apiPath: string): string {
  if (!apiPath.startsWith("/") || apiPath.startsWith("//") || apiPath.includes("\\") || apiPath.includes("#")) {
    throw new UserError("Gitea API request path must remain within the configured API base URL");
  }
  const base = new URL(apiBaseUrl);
  const target = new URL(`${apiBaseUrl}${apiPath}`);
  if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname}/`)) {
    throw new UserError("Gitea API request path must remain within the configured API base URL");
  }
  return target.href;
}

async function readyGiteaConnection(
  runner: CommandRunner,
  options: LifecycleOptions,
  containerId: string
): Promise<GiteaConnection> {
  const baseUrl = giteaHostBaseUrl(options);
  await waitForGitea(baseUrl);
  return {
    kind: "managed",
    ...await ensureGiteaCredentials(runner, options, containerId),
    apiBaseUrl: `${baseUrl}/api/v1`,
    hostBaseUrl: baseUrl,
    workspaceBaseUrl: "http://dim-gitea:3000",
    runnerBaseUrl: "http://dim-gitea:3000"
  };
}

function giteaHostBaseUrl(options: LifecycleOptions): string {
  const host = options.giteaHost.includes(":") ? `[${options.giteaHost}]` : options.giteaHost;
  return `http://${host}:${options.giteaPort}`;
}

async function waitForGitea(baseUrl: string): Promise<void> {
  let lastError = "not ready";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/healthz`, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new UserError(`Gitea did not become ready: ${lastError}`);
}

function assertCommand(result: { exitCode: number; stdout?: string; stderr: string }, action: string): void {
  if (result.exitCode !== 0) {
    throw new UserError(`Failed to ${action}: ${(result.stderr || result.stdout || "").trim()}`);
  }
}
