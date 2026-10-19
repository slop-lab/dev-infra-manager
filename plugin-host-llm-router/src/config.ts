import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import type { RouterIssuerConnection } from "./client.js";

export interface HostRouterConfig { schemaVersion: 1; stateDirectory: string; workspaceStateRoot: string;
  connection: RouterIssuerConnection; listen: {host: string; port: number}; publicEndpoint: string }
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("expected nonempty string"); return value; }
export function identifier(value: unknown): string { const result = text(value); if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(result)) throw new Error("invalid identifier"); return result; }
export function origin(value: unknown): string {
  const result = text(value), url = new URL(result);
  if (result !== url.origin || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && isIP(url.hostname.replace(/^\[|\]$/g, ""))))) throw new Error("endpoint must be an HTTPS origin or explicit HTTP IP origin"); return result;
}
export function parseIssuerConnection(value: unknown): RouterIssuerConnection {
  const row = object(value);
  if (row.schemaVersion !== 1 || Object.keys(row).sort().join() !== "endpoint,issuerId,issuerKeyFile,schemaVersion"
    || typeof row.issuerKeyFile !== "string" || !row.issuerKeyFile.startsWith("/")) throw new Error("invalid router issuer connection");
  return { schemaVersion: 1, endpoint: origin(text(row.endpoint)), issuerId: identifier(row.issuerId), issuerKeyFile: row.issuerKeyFile };
}
export function parseHostConfig(value: unknown): HostRouterConfig {
  const row = object(value), listen = object(row.listen);
  if (Object.keys(row).sort().join() !== "connection,listen,publicEndpoint,schemaVersion,stateDirectory,workspaceStateRoot" || row.schemaVersion !== 1
    || !isAbsolute(text(row.stateDirectory)) || !isAbsolute(text(row.workspaceStateRoot))
    || Object.keys(listen).sort().join() !== "host,port" || !isIP(text(listen.host)) || typeof listen.port !== "number"
    || !Number.isSafeInteger(listen.port) || listen.port < 1 || listen.port > 65535) throw new Error("invalid host LLM gateway configuration");
  return { schemaVersion: 1, stateDirectory: text(row.stateDirectory), workspaceStateRoot: text(row.workspaceStateRoot),
    connection: parseIssuerConnection(row.connection), listen: { host: text(listen.host), port: listen.port }, publicEndpoint: origin(row.publicEndpoint) };
}
export async function privateFile(path: string, maximum = 1024 * 1024): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o777) !== 0o600 || metadata.size > maximum) throw new Error("router inputs must be owned mode-0600 regular files");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
export async function loadHostConfig(path: string): Promise<HostRouterConfig> { return parseHostConfig(JSON.parse(await privateFile(path))); }
