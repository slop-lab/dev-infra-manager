import { cacheEndpoint } from "./protocol-plugin-api.js";
import type { HostExecutionRouting } from "@slop-lab/dim-host-core/plugin-api";
import { builtinMirrorAdapters, type MirrorAdapters } from "./registry.js";
export type CacheEndpoints = Readonly<Record<string, string>>;
export function parseEndpoints(input: unknown, adapters: MirrorAdapters = builtinMirrorAdapters): CacheEndpoints {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("cache endpoints must be an object");
  const entries = Object.entries(input);
  if (!entries.length || entries.length > 32) throw new Error("configure between one and 32 cache endpoints");
  return Object.fromEntries(entries.map(([kind, value]) => {
    const adapter = adapters.get(kind);
    if (!adapter) throw new Error(`unknown cache kind '${kind}'; install its mirror adapter plugin`);
    return [kind, cacheEndpoint(adapter.normalizeEndpoint(value))];
  }));
}
export function mirrorRouting(endpoints: CacheEndpoints, adapters: MirrorAdapters = builtinMirrorAdapters): HostExecutionRouting {
  const files = new Map<string, string>(), environment = new Map<string, string>(), blocked = new Set<string>(), environmentKeys = new Set<string>();
  let daemon: string | undefined;
  for (const [kind, endpoint] of Object.entries(endpoints)) {
    const adapter = adapters.get(kind);
    if (!adapter) throw new Error(`mirror adapter '${kind}' is unavailable`);
    const contribution = adapter.clientConfiguration(endpoint);
    for (const file of contribution.files) {
      if (files.has(file.target)) throw new Error(`conflicting mirror client file '${file.target}'`);
      files.set(file.target, file.contents);
    }
    for (const [key, value] of Object.entries(contribution.environmentDefaults ?? {})) {
      if (environmentKeys.has(key.toLowerCase())) throw new Error(`conflicting mirror environment default '${key}'`);
      environmentKeys.add(key.toLowerCase()); environment.set(key, value);
    }
    for (const hostname of contribution.blockedHostnames ?? []) blocked.add(hostname);
    if (contribution.dockerDaemonConfig !== undefined) {
      if (daemon !== undefined) throw new Error("conflicting mirror Docker daemon configuration");
      daemon = contribution.dockerDaemonConfig;
    }
  }
  return { network: "bridge", blockedHostnames: [...blocked], dockerDaemonConfig: daemon ?? "{}",
    jobFiles: [...files].map(([target, contents]) => ({ target, contents })), jobEnvironmentDefaults: Object.fromEntries(environment) };
}
