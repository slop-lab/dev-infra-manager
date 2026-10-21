import type { HostPluginExtension } from "@slop-lab/dim-host-core/plugin-api";
import { MIRROR_ADAPTER_EXTENSION, mirrorAdapterExtension, type MirrorAdapter, type MirrorAdapterModule } from "./protocol-plugin-api.js";
import { mirrorAdapter as docker } from "./adapters/docker/index.js";
import { mirrorAdapter as npm } from "./adapters/npm/index.js";
import { mirrorAdapter as pypi } from "./adapters/pypi/index.js";
import { mirrorAdapter as apt } from "./adapters/apt/index.js";
export type MirrorAdapters = ReadonlyMap<string, MirrorAdapter>;
export const builtinMirrorAdapters: MirrorAdapters = new Map([docker, npm, pypi, apt].map((adapter) => [adapter.kind, adapter]));
export function adapterModules(extensions: readonly HostPluginExtension[] = []): readonly MirrorAdapterModule[] {
  return extensions.filter(({ kind }) => kind === MIRROR_ADAPTER_EXTENSION).map(({ name, value }) => {
    if (!("moduleUrl" in value) || typeof value.moduleUrl !== "string") throw new Error(`invalid mirror adapter module '${name}'`);
    const extension = mirrorAdapterExtension(name, value.moduleUrl);
    return { kind: extension.name, moduleUrl: new URL(value.moduleUrl).href };
  });
}
export async function loadMirrorAdapters(modules: readonly MirrorAdapterModule[] = []): Promise<MirrorAdapters> {
  const result = new Map(builtinMirrorAdapters);
  for (const entry of modules) {
    mirrorAdapterExtension(entry.kind, entry.moduleUrl);
    if (result.has(entry.kind)) throw new Error(`duplicate mirror adapter '${entry.kind}'`);
    const imported: unknown = await import(entry.moduleUrl);
    const adapter = imported && typeof imported === "object" && "mirrorAdapter" in imported ? imported.mirrorAdapter : undefined;
    if (!adapter || typeof adapter !== "object" || !("kind" in adapter) || adapter.kind !== entry.kind
      || !("normalizeEndpoint" in adapter) || typeof adapter.normalizeEndpoint !== "function"
      || !("target" in adapter) || typeof adapter.target !== "function"
      || !("clientConfiguration" in adapter) || typeof adapter.clientConfiguration !== "function"
      || !("guestModuleUrl" in adapter) || typeof adapter.guestModuleUrl !== "string"
      || !("description" in adapter) || typeof adapter.description !== "string"
      || !("commands" in adapter) || !Array.isArray(adapter.commands)) throw new Error(`invalid mirror adapter '${entry.kind}'`);
    const guest = new URL(adapter.guestModuleUrl);
    if (guest.protocol !== "file:" || guest.hostname || guest.search || guest.hash) throw new Error(`mirror guest client '${entry.kind}' must be a local module`);
    result.set(entry.kind, adapter as MirrorAdapter);
  }
  return result;
}
