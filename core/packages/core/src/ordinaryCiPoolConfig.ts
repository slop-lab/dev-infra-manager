import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { UserError } from "./errors.js";
import {
  assertOrdinaryCiPoolServiceConfig,
  type OrdinaryCiPoolHost,
  type OrdinaryCiPoolServiceConfig
} from "./ordinaryCiPoolService.js";

export type OrdinaryCiPoolConnection = {
  readonly endpoint: string;
  readonly hostId: string;
  readonly token: string;
  readonly capacities: readonly string[];
  readonly expectedServiceId: string;
  readonly expectedJobImage: string;
};

export type OrdinaryCiPoolRegistrarConnection = {
  readonly endpoint: string;
  readonly token: string;
  readonly expectedServiceId: string;
  readonly expectedJobImage: string;
};

export type OrdinaryCiPoolServiceFile = {
  readonly listen: { readonly host: string; readonly port: number };
  readonly pool: OrdinaryCiPoolServiceConfig;
};

const TRANSPORTS = ["https", "loopback-http", "isolated-http"] as const;
type Transport = (typeof TRANSPORTS)[number];

export async function readOrdinaryCiPoolServiceConfig(file: string): Promise<OrdinaryCiPoolServiceFile> {
  const root = exactRecord(await readPrivateJson(file), [
    "schemaVersion", "listen", "serviceId", "database", "jobImage", "webhookBaseUrl",
    "registrarToken", "admissionLeaseMilliseconds", "hosts"
  ], "ordinary CI pool service");
  if (root.schemaVersion !== 2) throw new UserError("ordinary CI pool service schemaVersion must be 2");
  const listen = exactRecord(root.listen, ["host", "port"], "ordinary CI pool listen");
  const host = text(listen.host, "listen.host");
  if (host !== "127.0.0.1" && host !== "::1" && host !== "0.0.0.0") {
    throw new UserError("ordinary CI pool listen.host must be an explicit local bind address");
  }
  const pool: OrdinaryCiPoolServiceConfig = {
    schemaVersion: 2,
    serviceId: identifier(root.serviceId, "serviceId"),
    database: text(root.database, "database"),
    jobImage: text(root.jobImage, "jobImage"),
    webhookBaseUrl: text(root.webhookBaseUrl, "webhookBaseUrl"),
    registrarToken: text(root.registrarToken, "registrarToken"),
    admissionLeaseMilliseconds: positiveInteger(root.admissionLeaseMilliseconds, "admissionLeaseMilliseconds"),
    hosts: array(root.hosts, "hosts").map(parseHost)
  };
  assertOrdinaryCiPoolServiceConfig(pool);
  return { listen: { host, port: port(listen.port) }, pool };
}

export async function readOrdinaryCiPoolConnection(file: string): Promise<OrdinaryCiPoolConnection> {
  const root = exactRecord(await readPrivateJson(file), [
    "schemaVersion", "transport", "endpoint", "hostId", "token", "capacities", "expectedServiceId", "expectedJobImage"
  ], "ordinary CI pool connection");
  if (root.schemaVersion !== 3) throw new UserError("ordinary CI pool connection schemaVersion must be 3");
  const transport = parseTransport(root.transport);
  const expectedJobImage = text(root.expectedJobImage, "expectedJobImage");
  if (!digestImage(expectedJobImage)) {
    throw new UserError("ordinary CI pool expectedJobImage must be digest-pinned without a tag");
  }
  const capacities = array(root.capacities, "capacities").map((capacity) => identifier(capacity, "capacity"));
  if (capacities.length === 0 || new Set(capacities).size !== capacities.length) {
    throw new UserError("ordinary CI pool capacities must be unique and non-empty");
  }
  return {
    endpoint: endpoint(root.endpoint, transport),
    hostId: identifier(root.hostId, "hostId"),
    token: text(root.token, "token"),
    capacities,
    expectedServiceId: identifier(root.expectedServiceId, "expectedServiceId"),
    expectedJobImage
  };
}

export async function readOrdinaryCiPoolRegistrarConnection(file: string): Promise<OrdinaryCiPoolRegistrarConnection> {
  const root = exactRecord(await readPrivateJson(file), [
    "schemaVersion", "transport", "endpoint", "token", "expectedServiceId", "expectedJobImage"
  ], "ordinary CI pool registrar connection");
  if (root.schemaVersion !== 1) throw new UserError("ordinary CI pool registrar connection schemaVersion must be 1");
  const expectedJobImage = text(root.expectedJobImage, "expectedJobImage");
  if (!digestImage(expectedJobImage)) throw new UserError("ordinary CI pool expectedJobImage must be digest-pinned without a tag");
  return {
    endpoint: endpoint(root.endpoint, parseTransport(root.transport)),
    token: text(root.token, "token"),
    expectedServiceId: identifier(root.expectedServiceId, "expectedServiceId"),
    expectedJobImage
  };
}

async function readPrivateJson(file: string): Promise<unknown> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (isNodeError(error, "ENOENT")) throw new UserError("ordinary CI pool config file does not exist");
    if (isNodeError(error, "ELOOP")) throw new UserError("ordinary CI pool config must be a regular file");
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new UserError("ordinary CI pool config must be a regular file");
    if ((metadata.mode & 0o077) !== 0) throw new UserError("ordinary CI pool config must have mode 0600");
    if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
      throw new UserError("ordinary CI pool config must be owned by the DIM user");
    }
    try { return JSON.parse(await handle.readFile("utf8")); }
    catch (error) { if (error instanceof SyntaxError) throw new UserError("ordinary CI pool config must contain valid JSON"); throw error; }
  } finally { await handle.close(); }
}

function parseHost(value: unknown): OrdinaryCiPoolHost {
  const input = exactRecord(value, ["hostId", "token", "capacities"], "ordinary CI pool host");
  return {
    hostId: identifier(input.hostId, "hostId"),
    token: text(input.token, "token"),
    capacities: array(input.capacities, "capacities").map((capacity) => identifier(capacity, "capacity"))
  };
}

function endpoint(value: unknown, transport: Transport): string {
  const raw = text(value, "endpoint");
  let url: URL;
  try { url = new URL(raw); }
  catch (error) { if (error instanceof TypeError) throw new UserError("ordinary CI pool endpoint must be an absolute URL"); throw error; }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  const valid = transport === "https" ? url.protocol === "https:"
    : transport === "loopback-http" ? url.protocol === "http:" && loopback : url.protocol === "http:";
  if (!valid || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || (url.pathname !== "" && url.pathname !== "/")) {
    throw new UserError(`ordinary CI pool endpoint does not match configured ${transport} transport`);
  }
  return raw.replace(/\/$/, "");
}

function parseTransport(value: unknown): Transport {
  if (typeof value !== "string") throw new UserError(`ordinary CI pool transport must be one of ${TRANSPORTS.join(", ")}`);
  const parsed = TRANSPORTS.find((candidate) => candidate === value);
  if (parsed === undefined) throw new UserError(`ordinary CI pool transport must be one of ${TRANSPORTS.join(", ")}`);
  return parsed;
}

function exactRecord(value: unknown, fields: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UserError(`${label} must be an object`);
  const record = value as Readonly<Record<string, unknown>>;
  const unexpected = Object.keys(record).find((field) => !fields.includes(field));
  if (unexpected !== undefined) throw new UserError(`${label} contains unknown field '${unexpected}'`);
  const missing = fields.find((field) => record[field] === undefined);
  if (missing !== undefined) throw new UserError(`${label}.${missing} is required`);
  return record;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new UserError(`ordinary CI pool ${label} must be an array`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(parsed)) throw new UserError(`ordinary CI pool ${label} is invalid`);
  return parsed;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new UserError(`ordinary CI pool ${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new UserError(`ordinary CI pool ${label} must be positive`);
  return Number(value);
}

function port(value: unknown): number {
  const parsed = positiveInteger(value, "listen.port");
  if (parsed > 65_535) throw new UserError("ordinary CI pool listen.port must not exceed 65535");
  return parsed;
}

function digestImage(value: string): boolean {
  return /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/.test(value);
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value && value.code === code;
}
