import { lstat, readFile } from "node:fs/promises";
import { UserError } from "./errors.js";
import type { GiteaConnection, GiteaCredentials, GiteaProjectBinding } from "./lifecycleTypes.js";

const CONNECTION_FIELDS = [
  "schemaVersion", "apiBaseUrl", "hostBaseUrl", "workspaceBaseUrl", "runnerBaseUrl", "credentials", "projects"
] as const;
const CREDENTIAL_FIELDS = [
  "adminUsername", "adminPassword", "writerUsername", "writerPassword", "maintainerUsername", "maintainerPassword"
] as const;
const PROJECT_FIELDS = ["id", "gitNamespace", "giteaOrganizationId"] as const;

export async function externalGiteaConnection(file: string): Promise<GiteaConnection> {
  const metadata = await lstat(file);
  if (!metadata.isFile()) throw new UserError("External Gitea connection file must be a regular file");
  if ((metadata.mode & 0o077) !== 0) throw new UserError("External Gitea connection file must have mode 0600");
  if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
    throw new UserError("External Gitea connection file must be owned by the DIM user");
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UserError("External Gitea connection file must contain valid JSON");
    throw error;
  }
  const input = exactRecord(value, CONNECTION_FIELDS, "External Gitea connection");
  if (input.schemaVersion !== 1) throw new UserError("External Gitea connection schemaVersion must be 1");
  const credentials = parseCredentials(input.credentials);
  const connection = {
    kind: "external",
    apiBaseUrl: endpoint(input.apiBaseUrl, "apiBaseUrl", "/api/v1"),
    hostBaseUrl: endpoint(input.hostBaseUrl, "hostBaseUrl"),
    workspaceBaseUrl: endpoint(input.workspaceBaseUrl, "workspaceBaseUrl"),
    runnerBaseUrl: endpoint(input.runnerBaseUrl, "runnerBaseUrl"),
    ...credentials,
    projectBindings: parseProjectBindings(input.projects)
  } satisfies GiteaConnection;
  await validateExternalGitea(connection);
  return connection;
}

async function validateExternalGitea(connection: GiteaConnection): Promise<void> {
  const health = await request(connection, "/version");
  if (!health.ok) throw new UserError(`External Gitea health check failed: ${health.status}`);
  const authenticated = await request(connection, "/user");
  if (!authenticated.ok) throw new UserError(`Failed to authenticate external Gitea: ${authenticated.status}`);
  const value: unknown = await authenticated.json();
  if (!isRecord(value) || value.login !== connection.adminUsername) {
    throw new UserError("External Gitea authenticated identity does not match configured administrator");
  }
}

function request(connection: GiteaConnection, path: string): Promise<Response> {
  const authorization = Buffer.from(`${connection.adminUsername}:${connection.adminPassword}`).toString("base64");
  return fetch(`${connection.apiBaseUrl}${path}`, {
    headers: { Authorization: `Basic ${authorization}` },
    signal: AbortSignal.timeout(10_000)
  });
}

function parseCredentials(value: unknown): GiteaCredentials {
  const input = exactRecord(value, CREDENTIAL_FIELDS, "External Gitea credentials");
  return {
    adminUsername: text(input.adminUsername, "credentials.adminUsername"),
    adminPassword: text(input.adminPassword, "credentials.adminPassword"),
    writerUsername: text(input.writerUsername, "credentials.writerUsername"),
    writerPassword: text(input.writerPassword, "credentials.writerPassword"),
    maintainerUsername: text(input.maintainerUsername, "credentials.maintainerUsername"),
    maintainerPassword: text(input.maintainerPassword, "credentials.maintainerPassword")
  };
}

function parseProjectBindings(value: unknown): Readonly<Record<string, GiteaProjectBinding>> {
  if (!isRecord(value)) throw new UserError("External Gitea projects must be an object");
  return Object.fromEntries(Object.entries(value).map(([name, binding]) => {
    const input = exactRecord(binding, PROJECT_FIELDS, `External Gitea project '${name}'`);
    const organizationId = input.giteaOrganizationId;
    if (!Number.isSafeInteger(organizationId) || Number(organizationId) <= 0) {
      throw new UserError(`External Gitea project '${name}'.giteaOrganizationId must be a positive integer`);
    }
    return [name, {
      id: text(input.id, `projects.${name}.id`),
      gitNamespace: text(input.gitNamespace, `projects.${name}.gitNamespace`),
      giteaOrganizationId: Number(organizationId)
    }];
  }));
}

function endpoint(value: unknown, name: string, requiredSuffix?: string): string {
  const input = text(value, name);
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    if (error instanceof TypeError) throw new UserError(`External Gitea ${name} must be an absolute HTTP or HTTPS URL`);
    throw error;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new UserError(`External Gitea ${name} must be an absolute HTTP or HTTPS URL without credentials, query, or fragment`);
  }
  const normalized = input.replace(/\/+$/, "");
  if (requiredSuffix !== undefined && !normalized.endsWith(requiredSuffix)) {
    throw new UserError(`External Gitea ${name} must end with '${requiredSuffix}'`);
  }
  return normalized;
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new UserError(`${label} must be an object`);
  const unexpected = Object.keys(value).find((field) => !fields.includes(field));
  if (unexpected !== undefined) throw new UserError(`${label} contains unknown field '${unexpected}'`);
  const missing = fields.find((field) => value[field] === undefined);
  if (missing !== undefined) throw new UserError(`${label}.${missing} is required`);
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new UserError(`External Gitea ${name} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
