import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { jsonFiles, object, readJson, metadata } from "./files.ts";
import { inside } from "./paths.ts";
import type { DockerResource } from "./docker.ts";
import type { RemovalPaths } from "./types.ts";
export interface RetainedCacheData { readonly volumes: readonly string[]; readonly files: readonly string[] }
/** Cache payloads need their small ownership ledger to be reusable after reinstall. */
export async function retainedCacheData(paths: RemovalPaths, resources: readonly DockerResource[]): Promise<RetainedCacheData> {
  const volumes = resources.filter(({ claim }) => claim.kind === "volume" && claim.labels["dim.owner"] === "dim"
    && /^data:[a-z][a-z0-9-]{0,31}$/.test(claim.labels["dim.resource"] ?? "") && claim.labels["dim.service-id"] && claim.labels["dim.resource-id"]);
  const files: string[] = [];
  for (const root of new Set([paths.state, paths.managed])) for (const file of await jsonFiles(join(root, "plugins/cache-server/services"))) {
    const ledger = object(await readJson(file));
    if (volumes.some(({ claim }) => claim.labels["dim.service-id"] === ledger.serviceId)) files.push(file);
  }
  if (volumes.length && !files.length) throw new Error("cache data has no retained ownership ledger");
  const registry = resources.filter(({ claim }) => claim.kind === "volume" && claim.labels["dim.local-images"] && claim.labels["dim.resource"] === "volume");
  if (registry.length) {
    files.push(join(paths.data, "local-install/registry.json"));
    volumes.push(...registry);
  }
  return { volumes: volumes.map(({ claim }) => claim.name), files };
}
export async function removeExcept(root: string, retained: readonly string[]): Promise<void> {
  if (retained.includes(root) || !await metadata(root)) return;
  if (!retained.some((file) => inside(file, root))) { await rm(root, { recursive: true, force: true }); return; }
  for (const entry of await readdir(root)) await removeExcept(join(root, entry), retained);
}
