import type { StreamingCommandRunner } from "@slop-lab/dim-core";
import os from "node:os";
import path from "node:path";
import { cacheEndpoint, cacheKinds, clientFiles, DOCKER_HUB_DIRECT_HOSTNAMES, type CacheEndpoints, type MirrorRouting } from "./cache-routing.js";
import { object, privateJson } from "./relay-state.js";
export function hostStateRoot(): string {
  return path.resolve(process.env.DIM_STATE_ROOT ?? path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "dim"));
}
export function mirrorStateRoot(): string { return path.join(hostStateRoot(), "plugins/host-mirrors"); }
export function parseCacheCatalog(input: unknown): CacheEndpoints {
  const value = object(input);
  if (value.schemaVersion !== 1 || Object.keys(value).some((key) => key !== "schemaVersion" && key !== "endpoints")) throw new Error("expected cache URL catalog schemaVersion 1 and endpoints");
  const endpoints = object(value.endpoints);
  if (Object.keys(endpoints).some((key) => !cacheKinds.includes(key as typeof cacheKinds[number]))) throw new Error("unknown cache kind");
  return Object.fromEntries(cacheKinds.map((kind) => [kind, cacheEndpoint(endpoints[kind], kind)])) as CacheEndpoints;
}
/** Connecting never provisions a server. A server plugin may publish the same URL catalog. */
export async function readCacheEndpoints(): Promise<CacheEndpoints> {
  try { return parseCacheCatalog(await privateJson(path.join(mirrorStateRoot(), "config.json"))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  try { return parseCacheCatalog(await privateJson(path.join(hostStateRoot(), "services/package-caches.json"))); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error("cache URLs are not configured; run dim mirrors configure FILE, or install a cache server plugin and publish its endpoints");
    throw error;
  }
}
export const hostMirrorProvider = {
  async ensure(_runner: StreamingCommandRunner): Promise<MirrorRouting> {
    const endpoints = await readCacheEndpoints();
    return { network: "bridge", blockedHostnames: DOCKER_HUB_DIRECT_HOSTNAMES, jobFiles: clientFiles(endpoints), jobEnvironmentDefaults: { NPM_CONFIG_GLOBALCONFIG: "/etc/npmrc" },
      dockerDaemonConfig: JSON.stringify({ "registry-mirrors": [endpoints.docker], "insecure-registries": new URL(endpoints.docker).protocol === "http:" ? [new URL(endpoints.docker).host] : [] }) };
  }
};
