import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";

export interface RouterModel { id: string; name: string; api: "responses" | "chat"; context: number; output: number }
export interface RouterRoute { id: string; endpoint: string; keyFile: string; models: RouterModel[] }
export interface RouterConfig {
  schemaVersion: 1; stateDirectory: string; workspaceStateRoot: string; listen: { host: string; port: number };
  routes: RouterRoute[]; limits: { concurrent: number; requestsPerUtcDay: number; requestBytes: number;
    responseBytes: number; captureBytesPerWorkspace: number; deadlineMilliseconds: number };
}
export const defaultLimits: RouterConfig["limits"] = { concurrent: 2, requestsPerUtcDay: 1000,
  requestBytes: 1024 * 1024, responseBytes: 16 * 1024 * 1024,
  captureBytesPerWorkspace: 256 * 1024 * 1024, deadlineMilliseconds: 300_000 };
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}
function exact(row: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(row).length !== fields.length || fields.some((field) => !Object.hasOwn(row, field))) throw new Error("configuration contains missing or unsupported fields");
}
export function text(value: unknown): string { if (typeof value !== "string" || value.length === 0) throw new Error("expected nonempty string"); return value; }
export function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("invalid positive bound"); return value;
}
function absolute(value: unknown): string { const result = text(value); if (!isAbsolute(result)) throw new Error("path must be absolute"); return result; }
export function origin(value: unknown): string {
  const result = text(value), url = new URL(result);
  if (result !== url.origin || url.username || url.password || (url.protocol !== "https:" &&
    !(url.protocol === "http:" && isIP(url.hostname.replace(/^\[|\]$/g, ""))))) throw new Error("endpoint must be an HTTPS origin or explicit HTTP IP origin");
  return result;
}
function identifier(value: unknown): string { const result = text(value); if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(result)) throw new Error("invalid route identifier"); return result; }
export function parseConfig(value: unknown): RouterConfig {
  const row = object(value);
  exact(row, ["schemaVersion", "stateDirectory", "workspaceStateRoot", "listen", "routes", "limits"]);
  const listen = object(row.listen), limits = object(row.limits);
  exact(listen, ["host", "port"]);
  exact(limits, ["concurrent", "requestsPerUtcDay", "requestBytes", "responseBytes", "captureBytesPerWorkspace", "deadlineMilliseconds"]);
  if (row.schemaVersion !== 1 || !Array.isArray(row.routes) || row.routes.length === 0) throw new Error("unsupported router configuration");
  const routes = row.routes.map((value: unknown): RouterRoute => {
    const route = object(value);
    exact(route, ["id", "endpoint", "keyFile", "models"]);
    if (!Array.isArray(route.models) || route.models.length === 0) throw new Error("route requires explicit models");
    const endpoint = origin(route.endpoint), url = new URL(endpoint);
    if (url.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("HTTP upstream must use loopback");
    const models = route.models.map((value: unknown): RouterModel => {
      const model = object(value); exact(model, ["id", "name", "api", "context", "output"]);
      const id = text(model.id);
      if (id.length > 200 || /[\s\x00-\x1f]/.test(id) || (model.api !== "responses" && model.api !== "chat")) throw new Error("invalid model");
      return { id, name: text(model.name), api: model.api, context: integer(model.context), output: integer(model.output) };
    });
    if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error("duplicate model");
    return { id: identifier(route.id), endpoint, keyFile: absolute(route.keyFile), models };
  });
  if (new Set(routes.map((route) => route.id)).size !== routes.length || typeof listen.host !== "string" || !isIP(listen.host)) throw new Error("invalid routes or listen address");
  return { schemaVersion: 1, stateDirectory: absolute(row.stateDirectory), workspaceStateRoot: absolute(row.workspaceStateRoot),
    listen: { host: listen.host, port: integer(listen.port, 65535) }, routes,
    limits: { concurrent: integer(limits.concurrent, 128), requestsPerUtcDay: integer(limits.requestsPerUtcDay),
      requestBytes: integer(limits.requestBytes, 16 * 1024 * 1024), responseBytes: integer(limits.responseBytes, 128 * 1024 * 1024),
      captureBytesPerWorkspace: integer(limits.captureBytesPerWorkspace), deadlineMilliseconds: integer(limits.deadlineMilliseconds, 3_600_000) } };
}
export async function privateFile(path: string, maximum = 1024 * 1024): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.geteuid?.()
      || (metadata.mode & 0o777) !== 0o600 || metadata.size > maximum) throw new Error("router inputs must be owned mode-0600 regular files");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
export async function loadConfig(path: string): Promise<RouterConfig> { const value: unknown = JSON.parse(await privateFile(path)); return parseConfig(value); }
