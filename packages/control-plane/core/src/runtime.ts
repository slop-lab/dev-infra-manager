import type { ControlPlanePlugin, PreparedControlPlanePlugin, RunningControlPlanePlugin } from "./plugin.js";

export type ControlPlanePluginEntry = { readonly plugin: ControlPlanePlugin; readonly config: unknown };
/** Configure the whole composition before opening any services. Plugin code is operator-trusted. */
export async function startControlPlanePlugins(entries: readonly ControlPlanePluginEntry[], signal: AbortSignal): Promise<RunningControlPlanePlugin> {
  signal.throwIfAborted();
  const names = new Set<string>();
  const prepared: PreparedControlPlanePlugin[] = [];
  for (const { plugin, config } of entries) {
    if (plugin.apiVersion !== 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(plugin.name) || names.has(plugin.name)) {
      throw new Error("control-plane plugins must have distinct valid names and apiVersion 1");
    }
    names.add(plugin.name);
    prepared.push(await plugin.configure(config));
    signal.throwIfAborted();
  }
  const extensions = prepared.flatMap((entry) => entry.extensions ?? []);
  const identities = new Set<string>();
  const identity = ({ kind, name }: { readonly kind: string; readonly name: string }) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(kind)
      || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(name)) {
      throw new Error("control-plane extension kind and name must be valid identifiers");
    }
    return `${kind}:${name}`;
  };
  for (const extension of extensions) {
    const key = identity(extension);
    if (!extension.value || typeof extension.value !== "object" || Array.isArray(extension.value)) {
      throw new Error(`control-plane extension '${key}' must provide an object`);
    }
    if (identities.has(key)) throw new Error(`duplicate control-plane extension '${key}'`);
    identities.add(key);
  }
  for (const entry of prepared) for (const required of entry.requiresExtensions ?? []) {
    const key = identity(required);
    if (!identities.has(key)) throw new Error(`missing required control-plane extension '${key}'`);
  }
  const running: RunningControlPlanePlugin[] = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    // Reverse order is deliberate; continue cleanup after an individual close fails.
    const failures: unknown[] = [];
    for (const service of [...running].reverse()) {
      const [result] = await Promise.allSettled([Promise.resolve().then(() => service.close())]);
      if (result?.status === "rejected") failures.push(result.reason);
    }
    if (failures.length) throw new AggregateError(failures, "control-plane plugin shutdown failed");
  })();
  try {
    // Capabilities are supplied by configured code, not a dependency policy language.
    for (const entry of prepared) {
      signal.throwIfAborted();
      running.push(await entry.start({ signal, extensions }));
      signal.throwIfAborted();
    }
    return { close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "control-plane startup and cleanup failed"); }
    throw error;
  }
}
