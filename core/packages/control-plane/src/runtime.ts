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
  const compilers = prepared.flatMap((entry) => entry.workflowCompiler === undefined ? [] : [entry.workflowCompiler]);
  if (compilers.length > 1) throw new Error("only one control-plane workflow compiler may be configured");
  const workflowCompiler = compilers[0];
  if (workflowCompiler === undefined && prepared.some((entry) => entry.requiresWorkflowCompiler)) {
    throw new Error("a configured control-plane plugin requires a workflow compiler plugin");
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
    for (const entry of [...prepared.filter((entry) => entry.workflowCompiler !== undefined),
      ...prepared.filter((entry) => entry.workflowCompiler === undefined)]) {
      signal.throwIfAborted();
      running.push(await entry.start({ signal, ...(workflowCompiler === undefined ? {} : { workflowCompiler }) }));
      signal.throwIfAborted();
    }
    return { close };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "control-plane startup and cleanup failed"); }
    throw error;
  }
}
