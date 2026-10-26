import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "../errors.js";
import { hostPluginHome } from "./host-plugins.js";

export interface AgentConfiguration {
  workspaceId: string; workspaceName: string; stateRoot: string; host: string; token: string; generation: string;
}
export type StoredAgentConfiguration = Omit<AgentConfiguration, "generation"> & { generation?: string };

export async function privateJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1 || metadata.size > 16_384) throw new UserError("workspace bridge configuration must be a private owner-only regular file");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
export function parseStoredConfiguration(value: unknown): StoredAgentConfiguration {
  if (!isObject(value) || typeof value.workspaceId !== "string" || !/^[0-9a-f-]{36}$/.test(value.workspaceId)
    || typeof value.workspaceName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value.workspaceName)
    || typeof value.stateRoot !== "string" || !path.isAbsolute(value.stateRoot)
    || typeof value.host !== "string" || isIP(value.host) !== 4
    || value.generation !== undefined && (typeof value.generation !== "string" || !/^[0-9a-f]{64}$/.test(value.generation))
    || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new UserError("invalid workspace bridge configuration");
  return { workspaceId: value.workspaceId, workspaceName: value.workspaceName, stateRoot: value.stateRoot, host: value.host, token: value.token,
    ...(value.generation === undefined ? {} : { generation: value.generation }) };
}
export function parseConfiguration(value: unknown): AgentConfiguration {
  const config = parseStoredConfiguration(value);
  if (!config.generation) throw new UserError("workspace bridge configuration requires a current generation");
  return { ...config, generation: config.generation };
}
export async function workspaceAgentGeneration(): Promise<string> {
  const hash = createHash("sha256").update("dim-workspace-stdio-bridge-v3\0");
  const source = fileURLToPath(import.meta.url);
  for (const file of [source, ...["workspace-agent", "workspace-agent-process", "host-plugins", "workspace-composition"].map((name) => path.join(path.dirname(source), `${name}${path.extname(source)}`))]) {
    hash.update(file).update("\0").update(await readFile(file)).update("\0");
  }
  for (const name of ["serviceChannel", "serviceChannelGuest", "serviceChannelReconnect", "serviceEndpoint"]) hash.update(await readFile(path.join(path.dirname(source), "../workspace", `${name}${path.extname(source)}`)));
  const home = hostPluginHome(); hash.update(home).update("\0");
  try {
    const metadata = await stat(home, { bigint: true }); hash.update(`${metadata.dev}:${metadata.ino}\0`);
  } catch (error) { if (!hasCode(error, "ENOENT")) throw error; hash.update("absent\0"); }
  let manifest: string;
  try { manifest = await readFile(path.join(home, "plugins.json"), "utf8"); }
  catch (error) { if (!hasCode(error, "ENOENT")) throw error; return hash.update("no-plugins").digest("hex"); }
  hash.update(manifest).update("\0");
  const value: unknown = JSON.parse(manifest);
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.plugins)
    || !value.plugins.every((name: unknown) => typeof name === "string" && name.length > 0)) throw new UserError("invalid installed DIM plugin manifest");
  const installed = createRequire(path.join(home, "package.json"));
  for (const name of value.plugins) {
    const file = installed.resolve(name); hash.update(name).update("\0").update(file).update("\0").update(await readFile(file)).update("\0");
  }
  return hash.digest("hex");
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hasCode(value: unknown, code: string): boolean { return isObject(value) && value.code === code; }
