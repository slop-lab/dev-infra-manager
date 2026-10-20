import os from "node:os";
import path from "node:path";
import { parseEndpoints, mirrorRouting, type CacheEndpoints } from "./cache-routing.js";
import { builtinMirrorAdapters, type MirrorAdapters } from "./registry.js";
import { object, privateJson } from "./relay-state.js";
export function hostStateRoot(): string {
  return path.resolve(process.env.DIM_STATE_ROOT ?? path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "dim"));
}
export function mirrorStateRoot(): string { return path.join(hostStateRoot(), "plugins/host-mirrors"); }
export function parseCacheCatalog(input: unknown, adapters: MirrorAdapters = builtinMirrorAdapters): CacheEndpoints {
  const value = object(input);
  if (value.schemaVersion !== 1 || Object.keys(value).some((key) => key !== "schemaVersion" && key !== "endpoints")) throw new Error("expected cache URL catalog schemaVersion 1 and endpoints");
  return parseEndpoints(value.endpoints, adapters);
}
/** Connecting never provisions a server. A server plugin may publish the same URL catalog. */
export async function findCacheEndpoints(adapters: MirrorAdapters = builtinMirrorAdapters): Promise<CacheEndpoints | undefined> {
  try { return parseCacheCatalog(await privateJson(path.join(mirrorStateRoot(), "config.json")), adapters); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  try { return parseCacheCatalog(await privateJson(path.join(hostStateRoot(), "services/package-caches.json")), adapters); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
export async function readCacheEndpoints(adapters: MirrorAdapters = builtinMirrorAdapters): Promise<CacheEndpoints> {
  const endpoints = await findCacheEndpoints(adapters);
  if (!endpoints) throw new Error("cache URLs are not configured; run dim mirrors configure FILE, or install a cache server plugin and publish its endpoints");
  return endpoints;
}
export async function resolveMirrorRouting(adapters: MirrorAdapters = builtinMirrorAdapters) {
  return mirrorRouting(await readCacheEndpoints(adapters), adapters);
}
