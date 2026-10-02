import { UserError } from "./errors.js";
import { externalGiteaConnection } from "./giteaExternalConnection.js";
import {
  giteaChangePasswordArgs,
  giteaWebhookConfigArgs,
  GITEA_CONTAINER,
  GITEA_NETWORK,
  GITEA_VOLUME
} from "./giteaContainer.js";
import {
  configureManagedGiteaWebhookAllowedHosts,
  ensureManagedGitea
} from "./giteaManagedService.js";
import type { GiteaConnection, LifecycleOptions } from "./lifecycleTypes.js";
import type { CommandRunner } from "./types.js";

export { giteaChangePasswordArgs, giteaWebhookConfigArgs, GITEA_CONTAINER, GITEA_NETWORK, GITEA_VOLUME };
export type { GiteaConnection } from "./lifecycleTypes.js";

export async function ensureGitea(runner: CommandRunner, options: LifecycleOptions): Promise<GiteaConnection> {
  if (options.giteaConnection.kind === "external") {
    return externalGiteaConnection(options.giteaConnection.file);
  }
  return ensureManagedGitea(runner, options);
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
  await configureManagedGiteaWebhookAllowedHosts(runner, options, hosts);
}

export function giteaInternalCloneUrl(connection: GiteaConnection, owner: string, repo: string): string {
  return `${connection.workspaceBaseUrl}/${owner}/${repo}.git`;
}

export function giteaHostCloneUrl(connection: GiteaConnection, owner: string, repo: string): string {
  return `${connection.hostBaseUrl}/${owner}/${repo}.git`;
}

export async function giteaNestedBaseUrl(runner: CommandRunner, connection: GiteaConnection): Promise<string> {
  if (connection.kind === "external") return connection.workspaceBaseUrl;
  void runner;
  const host = connection.endpointAddress.includes(":") ? `[${connection.endpointAddress}]` : connection.endpointAddress;
  return `http://${host}:3000`;
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
