import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { UserError } from "./errors.js";
import { validateLifecycleName } from "./lifecycleRecord.js";
import type { GiteaConnection, GiteaCredentials, GiteaProjectBinding } from "./lifecycleTypes.js";

const CONNECTION_FIELDS = [
  "schemaVersion", "transport", "hostId", "apiBaseUrl", "hostBaseUrl", "workspaceBaseUrl", "runnerBaseUrl",
  "credentials", "projects"
] as const;
const CREDENTIAL_FIELDS = [
  "adminUsername", "adminPassword", "writerUsername", "writerPassword", "maintainerUsername", "maintainerPassword"
] as const;
const PROJECT_FIELDS = ["id", "gitNamespace", "giteaOrganizationId"] as const;
const TRANSPORTS = ["https", "loopback-http", "isolated-http"] as const;
type Transport = (typeof TRANSPORTS)[number];

export async function externalGiteaConnection(file: string): Promise<GiteaConnection> {
  const input = exactRecord(await readConnectionFile(file), CONNECTION_FIELDS, "External Gitea connection");
  if (input.schemaVersion !== 1) throw new UserError("External Gitea connection schemaVersion must be 1");
  const transport = parseTransport(input.transport);
  const credentials = parseCredentials(input.credentials);
  assertDistinctCredentials(credentials);
  const connection = {
    kind: "external",
    hostId: validateLifecycleName(text(input.hostId, "hostId"), "external Gitea host"),
    apiBaseUrl: endpoint(input.apiBaseUrl, "apiBaseUrl", transport, "/api/v1"),
    hostBaseUrl: endpoint(input.hostBaseUrl, "hostBaseUrl", transport),
    workspaceBaseUrl: endpoint(input.workspaceBaseUrl, "workspaceBaseUrl", transport),
    runnerBaseUrl: endpoint(input.runnerBaseUrl, "runnerBaseUrl", transport),
    ...credentials,
    projectBindings: parseProjectBindings(input.projects)
  } satisfies GiteaConnection;
  assertUnique([
    connection.apiBaseUrl,
    connection.hostBaseUrl,
    connection.workspaceBaseUrl,
    connection.runnerBaseUrl
  ], "endpoint");
  await validateExternalGitea(connection);
  return connection;
}

async function readConnectionFile(file: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) throw new UserError("External Gitea connection file must be a regular file");
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new UserError("External Gitea connection file must be a regular file");
    if ((metadata.mode & 0o077) !== 0) throw new UserError("External Gitea connection file must have mode 0600");
    if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
      throw new UserError("External Gitea connection file must be owned by the DIM user");
    }
    try {
      return JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new UserError("External Gitea connection file must contain valid JSON");
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function validateExternalGitea(connection: GiteaConnection): Promise<void> {
  const health = await request(connection, "/version", connection.adminUsername, connection.adminPassword);
  if (!health.ok) throw new UserError(`External Gitea health check failed: ${health.status}`);
  await validateIdentity(connection, "administrator", connection.adminUsername, connection.adminPassword, true);
  await validateIdentity(connection, "writer", connection.writerUsername, connection.writerPassword, false);
  await validateIdentity(connection, "maintainer", connection.maintainerUsername, connection.maintainerPassword, false);
}

async function validateIdentity(
  connection: GiteaConnection,
  role: string,
  username: string,
  password: string,
  admin: boolean
): Promise<void> {
  const response = await request(connection, "/user", username, password);
  if (!response.ok) throw new UserError(`Failed to authenticate external Gitea ${role}: ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value) || value.login !== username) {
    throw new UserError(`External Gitea authenticated ${role} identity does not match configuration`);
  }
  if (value.is_admin !== admin) {
    throw new UserError(`External Gitea ${role} must be ${admin ? "an administrator" : "a non-administrator"}`);
  }
}

async function request(
  connection: GiteaConnection,
  path: string,
  username: string,
  password: string
): Promise<Response> {
  const authorization = Buffer.from(`${username}:${password}`).toString("base64");
  const response = await fetch(`${connection.apiBaseUrl}${path}`, {
    headers: { Authorization: `Basic ${authorization}` },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000)
  });
  if (response.status >= 300 && response.status < 400) {
    throw new UserError("External Gitea API redirects are not allowed");
  }
  return response;
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

function assertDistinctCredentials(credentials: GiteaCredentials): void {
  const usernames = [credentials.adminUsername, credentials.writerUsername, credentials.maintainerUsername];
  if (new Set(usernames).size !== usernames.length) {
    throw new UserError("External Gitea credentials must use distinct role identities");
  }
}

function parseProjectBindings(value: unknown): Readonly<Record<string, GiteaProjectBinding>> {
  if (!isRecord(value)) throw new UserError("External Gitea projects must be an object");
  const bindings = Object.entries(value).map(([name, binding]) => {
    identifier(name, `projects.${name}`);
    const input = exactRecord(binding, PROJECT_FIELDS, `External Gitea project '${name}'`);
    const organizationId = input.giteaOrganizationId;
    if (!Number.isSafeInteger(organizationId) || Number(organizationId) <= 0) {
      throw new UserError(`External Gitea project '${name}'.giteaOrganizationId must be a positive integer`);
    }
    const parsed = {
      id: identifier(input.id, `projects.${name}.id`),
      gitNamespace: identifier(input.gitNamespace, `projects.${name}.gitNamespace`),
      giteaOrganizationId: Number(organizationId)
    } satisfies GiteaProjectBinding;
    if (parsed.gitNamespace !== `dim-${name}`) {
      throw new UserError(`External Gitea project '${name}'.gitNamespace must be 'dim-${name}'`);
    }
    return [name, parsed] as const;
  });
  assertUnique(bindings.map(([, binding]) => binding.id), "Project id");
  assertUnique(bindings.map(([, binding]) => binding.gitNamespace), "Project namespace");
  assertUnique(bindings.map(([, binding]) => binding.giteaOrganizationId), "Project organization ID");
  return Object.fromEntries(bindings);
}

function assertUnique(values: readonly (string | number)[], label: string): void {
  if (new Set(values).size !== values.length) throw new UserError(`External Gitea ${label} values must be unique`);
}

function parseTransport(value: unknown): Transport {
  if (typeof value !== "string" || !TRANSPORTS.includes(value as Transport)) {
    throw new UserError(`External Gitea transport must be one of ${TRANSPORTS.join(", ")}`);
  }
  return value as Transport;
}

function endpoint(value: unknown, name: string, transport: Transport, requiredSuffix?: string): string {
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
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  const valid = transport === "https"
    ? url.protocol === "https:"
    : transport === "loopback-http"
      ? url.protocol === "http:" && loopback
      : url.protocol === "http:";
  if (!valid) throw new UserError(`External Gitea ${name} does not match configured ${transport} transport`);
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

function identifier(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(parsed)) {
    throw new UserError(`External Gitea ${name} must be a safe identifier`);
  }
  return parsed;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new UserError(`External Gitea ${name} must be a non-empty string`);
  return value;
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
