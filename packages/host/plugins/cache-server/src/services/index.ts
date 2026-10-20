import { dockerService } from "./docker.js";
import { npmService } from "./npm.js";
import { pypiService } from "./pypi.js";
import { aptService } from "./apt.js";
import type { CacheServiceAdapter } from "./types.js";

export const cacheServices: readonly CacheServiceAdapter[] = [dockerService, npmService, pypiService, aptService];

export function selectCacheServices(kinds: readonly string[] = cacheServices.map(({ kind }) => kind)): readonly CacheServiceAdapter[] {
  if (!kinds.length || new Set(kinds).size !== kinds.length) throw new Error("select one or more distinct cache services: docker npm pypi apt");
  return kinds.map((kind) => {
    const adapter = cacheServices.find((service) => service.kind === kind);
    if (!adapter) throw new Error(`unknown cache service '${kind}'; choose docker npm pypi apt`);
    return adapter;
  });
}
