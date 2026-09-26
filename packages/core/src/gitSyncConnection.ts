import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { UserError } from "./errors.js";
import { configuredExternalGiteaConnection } from "./giteaExternalConnection.js";
import type { GitSyncConnection, LifecycleOptions } from "./lifecycleTypes.js";

const FIELDS = ["schemaVersion", "transport", "hostId", "endpoint", "token", "timeoutSeconds"] as const;
const TRANSPORTS = ["https", "loopback-http", "isolated-http"] as const;

export async function gitSyncConnection(options: LifecycleOptions): Promise<GitSyncConnection> {
  const configured = options.gitSyncConnection;
  if (configured === undefined) {
    throw new UserError("repository synchronization requires DIM_GIT_SYNC_CONNECTION_FILE");
  }
  const handle = await open(configured.file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if (isNodeError(error, "ELOOP")) throw new UserError("Git sync connection file must be a regular file");
    throw error;
  });
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new UserError("Git sync connection file must be a regular file");
    if ((metadata.mode & 0o077) !== 0) throw new UserError("Git sync connection file must have mode 0600");
    if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
      throw new UserError("Git sync connection file must be owned by the DIM user");
    }
    let value: unknown;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new UserError("Git sync connection file must contain valid JSON");
      throw error;
    }
    const input = exactRecord(value);
    if (input.schemaVersion !== 1) throw new UserError("Git sync connection schemaVersion must be 1");
    const transport = text(input.transport, "transport");
    if (!TRANSPORTS.some((candidate) => candidate === transport)) {
      throw new UserError(`Git sync transport must be one of ${TRANSPORTS.join(", ")}`);
    }
    const hostId = identifier(input.hostId, "hostId");
    if (options.giteaConnection.kind === "external") {
      const gitea = await configuredExternalGiteaConnection(options.giteaConnection.file);
      if (hostId !== gitea.hostId) throw new UserError("Git sync host identity must match the external Gitea host identity");
    }
    return {
      endpoint: endpoint(input.endpoint, transport),
      hostId,
      token: text(input.token, "token"),
      timeoutSeconds: positiveInteger(input.timeoutSeconds, "timeoutSeconds", 10, 3_600)
    };
  } finally {
    await handle.close();
  }
}

function exactRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new UserError("Git sync connection must be an object");
  const unexpected = Object.keys(value).find((field) => !FIELDS.some((candidate) => candidate === field));
  if (unexpected !== undefined) throw new UserError(`Git sync connection contains unknown field '${unexpected}'`);
  const missing = FIELDS.find((field) => value[field] === undefined);
  if (missing !== undefined) throw new UserError(`Git sync connection.${missing} is required`);
  return value;
}

function endpoint(value: unknown, transport: string): string {
  const raw = text(value, "endpoint");
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    if (error instanceof TypeError) throw new UserError("Git sync endpoint must be an absolute URL");
    throw error;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || (url.pathname !== "" && url.pathname !== "/")) {
    throw new UserError("Git sync endpoint must not contain credentials, path, query, or fragment");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  const valid = transport === "https" ? url.protocol === "https:"
    : transport === "loopback-http" ? url.protocol === "http:" && loopback
      : url.protocol === "http:";
  if (!valid) throw new UserError(`Git sync endpoint does not match configured ${transport} transport`);
  return raw.replace(/\/$/, "");
}

function positiveInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new UserError(`Git sync ${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function identifier(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parsed)) throw new UserError(`Git sync ${name} is not a safe identifier`);
  return parsed;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new UserError(`Git sync ${name} must be a non-empty string`);
  return value;
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
