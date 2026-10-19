import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";

export interface RouterModel { id: string; name: string; api: "responses" | "chat"; context: number; output: number }
export interface RouterAccount { id: string; reference: string; endpoint: string; keyFile: string; credentialDirectory?: string }
export interface RouterRoute { id: string; accountId: string; models: RouterModel[] }
export interface RouterLimits { concurrent: number; requestsPerUtcDay: number; requestBytes: number; responseBytes: number; captureBytesPerProject: number; deadlineMilliseconds: number }
export interface ProjectPolicy { allowedRoutes: string[]; limits: RouterLimits; captureMode: "required" | "best-effort" | "metadata";
  tokenMode: "observe" | "estimate"; tokensPerUtcDay?: number; estimatedTokensPerRequest?: number }
export interface RouterHostIssuer { id: string; keyFile: string; projects: { id: string; routeIds: string[] }[] }
export interface RouterConfig {
  schemaVersion: 3; stateDirectory: string; hostIssuers: RouterHostIssuer[]; listen: { host: string; port: number };
  backend: { name: "CLIProxyAPI"; version: "8.0.33"; accountSelection: "exclusive-worker"; attemptVisibility: "request-only"; cancellation: "best-effort" };
  accounts: RouterAccount[]; routes: RouterRoute[]; limits: RouterLimits;
}
export const backendProfile: RouterConfig["backend"] = { name: "CLIProxyAPI", version: "8.0.33", accountSelection: "exclusive-worker", attemptVisibility: "request-only", cancellation: "best-effort" };
export const defaultLimits: RouterLimits = { concurrent: 2, requestsPerUtcDay: 1000, requestBytes: 1024 * 1024,
  responseBytes: 16 * 1024 * 1024, captureBytesPerProject: 256 * 1024 * 1024, deadlineMilliseconds: 300_000 };
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object"); return value as Record<string, unknown>;
}
function exact(row: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some((field) => !Object.hasOwn(row, field)) || Object.keys(row).some((field) => !required.includes(field) && !optional.includes(field))) throw new Error("configuration contains missing or unsupported fields");
}
export function text(value: unknown): string { if (typeof value !== "string" || value.length === 0) throw new Error("expected nonempty string"); return value; }
export function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("invalid positive bound"); return value;
}
function absolute(value: unknown): string { const result = text(value); if (!isAbsolute(result)) throw new Error("path must be absolute"); return result; }
export function origin(value: unknown): string {
  const result = text(value), url = new URL(result);
  if (result !== url.origin || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && isIP(url.hostname.replace(/^\[|\]$/g, ""))))) throw new Error("endpoint must be an HTTPS origin or explicit HTTP IP origin"); return result;
}
export function identifier(value: unknown): string { const result = text(value); if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(result)) throw new Error("invalid identifier"); return result; }
export function parseLimits(value: unknown): RouterLimits {
  const limits = object(value); exact(limits, Object.keys(defaultLimits));
  return { concurrent: integer(limits.concurrent, 128), requestsPerUtcDay: integer(limits.requestsPerUtcDay), requestBytes: integer(limits.requestBytes, 16 * 1024 * 1024),
    responseBytes: integer(limits.responseBytes, 128 * 1024 * 1024), captureBytesPerProject: integer(limits.captureBytesPerProject), deadlineMilliseconds: integer(limits.deadlineMilliseconds, 3_600_000) };
}
export function parsePolicy(value: unknown): ProjectPolicy {
  const row = object(value); exact(row, ["allowedRoutes", "limits", "captureMode", "tokenMode"], ["tokensPerUtcDay", "estimatedTokensPerRequest"]);
  if (row.tokenMode === "strict") throw new Error("strict token admission is unsupported: this backend has no verified consumption/attempt upper bound");
  if (!Array.isArray(row.allowedRoutes) || !row.allowedRoutes.length || !["required", "best-effort", "metadata"].includes(String(row.captureMode)) || !["observe", "estimate"].includes(String(row.tokenMode))) throw new Error("invalid project policy");
  const routes = row.allowedRoutes.map(identifier); if (new Set(routes).size !== routes.length) throw new Error("duplicate route");
  if (row.tokenMode === "estimate" && (row.tokensPerUtcDay === undefined || row.estimatedTokensPerRequest === undefined)) throw new Error("estimate mode requires a daily allowance and per-request estimate");
  return { allowedRoutes: routes, limits: parseLimits(row.limits), captureMode: row.captureMode === "required" ? "required" : row.captureMode === "metadata" ? "metadata" : "best-effort",
    tokenMode: row.tokenMode === "estimate" ? "estimate" : "observe", ...(row.tokensPerUtcDay === undefined ? {} : { tokensPerUtcDay: integer(row.tokensPerUtcDay) }),
    ...(row.estimatedTokensPerRequest === undefined ? {} : { estimatedTokensPerRequest: integer(row.estimatedTokensPerRequest) }) };
}
export function parseConfig(value: unknown): RouterConfig {
  const row = object(value); exact(row, ["schemaVersion", "stateDirectory", "hostIssuers", "listen", "backend", "accounts", "routes", "limits"]);
  const listen = object(row.listen), backend = object(row.backend); exact(listen, ["host", "port"]); exact(backend, Object.keys(backendProfile));
  if (Object.entries(backendProfile).some(([key, value]) => backend[key] !== value)) throw new Error("unsupported backend capabilities; only pinned exclusive-worker/request-level CLIProxyAPI profile is enabled");
  if (row.schemaVersion !== 3 || !Array.isArray(row.routes) || !row.routes.length || !Array.isArray(row.accounts) || !row.accounts.length) throw new Error("unsupported router configuration");
  const accounts = row.accounts.map((value: unknown): RouterAccount => {
    const account = object(value); exact(account, ["id", "reference", "endpoint", "keyFile"], ["credentialDirectory"]);
    const endpoint = origin(account.endpoint), url = new URL(endpoint);
    if (url.protocol === "http:" && !["127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("HTTP upstream must use loopback");
    return { id: identifier(account.id), reference: text(account.reference), endpoint, keyFile: absolute(account.keyFile), ...(account.credentialDirectory === undefined ? {} : { credentialDirectory: absolute(account.credentialDirectory) }) };
  });
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length || new Set(accounts.map((account) => account.endpoint)).size !== accounts.length) throw new Error("account IDs and exclusive backend endpoints must be unique");
  if (!Array.isArray(row.hostIssuers)) throw new Error("host issuers must be an explicit array");
  const hostIssuers = row.hostIssuers.map((value: unknown): RouterHostIssuer => {
    const issuer = object(value); exact(issuer, ["id", "keyFile", "projects"]);
    if (!Array.isArray(issuer.projects) || !issuer.projects.length) throw new Error("host issuer requires explicit project scopes");
    const projects = issuer.projects.map((value: unknown) => {
      const project = object(value); exact(project, ["id", "routeIds"]);
      if (!Array.isArray(project.routeIds) || !project.routeIds.length) throw new Error("host issuer requires explicit routes");
      const routeIds = project.routeIds.map(identifier);
      if (new Set(routeIds).size !== routeIds.length) throw new Error("duplicate issuer route");
      return { id: identifier(project.id), routeIds };
    });
    if (new Set(projects.map(({ id }) => id)).size !== projects.length) throw new Error("duplicate issuer project");
    return { id: identifier(issuer.id), keyFile: absolute(issuer.keyFile), projects };
  });
  if (new Set(hostIssuers.map(({ id }) => id)).size !== hostIssuers.length) throw new Error("duplicate host issuer");
  const routes = row.routes.map((value: unknown): RouterRoute => {
    const route = object(value); exact(route, ["id", "accountId", "models"]);
    if (!Array.isArray(route.models) || !route.models.length || !accounts.some((account) => account.id === route.accountId)) throw new Error("route requires models and an exclusive account reference");
    const models = route.models.map((value: unknown): RouterModel => {
      const model = object(value); exact(model, ["id", "name", "api", "context", "output"]); const id = text(model.id);
      if (id.length > 200 || /[\s\x00-\x1f]/.test(id) || (model.api !== "responses" && model.api !== "chat")) throw new Error("invalid model");
      return { id, name: text(model.name), api: model.api, context: integer(model.context), output: integer(model.output) };
    });
    if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error("duplicate model");
    return { id: identifier(route.id), accountId: identifier(route.accountId), models };
  });
  if (new Set(routes.map((route) => route.id)).size !== routes.length || typeof listen.host !== "string" || !isIP(listen.host)) throw new Error("invalid routes or listen address");
  if (hostIssuers.some((issuer) => issuer.projects.some((project) => project.routeIds.some((id) => !routes.some((route) => route.id === id))))) throw new Error("issuer refers to unknown route");
  return { schemaVersion: 3, stateDirectory: absolute(row.stateDirectory), hostIssuers, listen: { host: listen.host, port: integer(listen.port, 65535) }, backend: { ...backendProfile }, accounts, routes, limits: parseLimits(row.limits) };
}
export async function privateFile(path: string, maximum = 1024 * 1024): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o777) !== 0o600 || metadata.size > maximum) throw new Error("router inputs must be owned mode-0600 regular files");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
export async function loadConfig(path: string): Promise<RouterConfig> { const value: unknown = JSON.parse(await privateFile(path)); return parseConfig(value); }
