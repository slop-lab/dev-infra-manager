import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
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
  function endpoint(input: unknown) { const endpoint = object(input); if (typeof endpoint.host !== "string" || isIP(endpoint.host) !== 4 || typeof endpoint.port !== "number" || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw new Error("invalid private mirror endpoint"); return { host: endpoint.host, port: endpoint.port }; }
  return { workspaceStateRoot: value.workspaceStateRoot, workspaceName: value.workspaceName, workspaceId: value.workspaceId,
    listen: value.listen, controlToken: value.controlToken, configurationId: value.configurationId, registry: endpoint(value.registry), apt: endpoint(value.apt) };
}
export async function privateJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 16 * 1024) throw new Error("mirror configuration must be an owned private file"); return JSON.parse(await handle.readFile("utf8")); }
  finally { await handle.close(); }
}
