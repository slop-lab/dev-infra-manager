import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { cacheEndpoint, cacheKinds, type CacheEndpoints } from "./cache-routing.js";
import { isIP } from "node:net";
import type { MirrorRelayConfig } from "./relay.js";
export function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid private mirror state"); return value as Record<string, unknown>; }
export function parseRelayConfig(input: unknown): MirrorRelayConfig {
  const value = object(input);
  if (typeof value.workspaceStateRoot !== "string" || !isAbsolute(value.workspaceStateRoot) || typeof value.workspaceName !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.workspaceName)
    || typeof value.workspaceId !== "string" || !/^[0-9a-f-]{36}$/.test(value.workspaceId)
    || typeof value.listen !== "string" || isIP(value.listen) !== 4
    || typeof value.controlToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.controlToken)
    || typeof value.configurationId !== "string" || !/^[0-9a-f-]{36}$/.test(value.configurationId)) throw new Error("invalid private mirror relay configuration");
  const supplied = object(value.endpoints);
  const endpoints = Object.fromEntries(cacheKinds.map((kind) => [kind, cacheEndpoint(supplied[kind], kind)])) as CacheEndpoints;
  return { workspaceStateRoot: value.workspaceStateRoot, workspaceName: value.workspaceName, workspaceId: value.workspaceId,
    listen: value.listen, controlToken: value.controlToken, configurationId: value.configurationId, endpoints };
}
export async function privateJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16 * 1024) throw new Error("mirror configuration must be an owned private file"); return JSON.parse(await handle.readFile("utf8")); }
  finally { await handle.close(); }
}
