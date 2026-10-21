import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { operationDescriptors, type OperationAccess } from "@slop-lab/dim-contracts-operations";
import type { WebPlugin, WebPluginRuntime } from "./plugin-api.js";
import { HttpResponseError } from "./http-response.js";

export interface WebPluginSelection { readonly package: string; readonly config?: unknown }
export interface LoadedWebPlugin {
  readonly definition: WebPlugin;
  readonly config?: unknown;
  runtime?: WebPluginRuntime;
  status: "ready" | "unconfigured" | "unavailable";
  reconnecting?: Promise<void>;
}
export async function reconnectWebPlugin(plugin: LoadedWebPlugin): Promise<void> {
  if (plugin.config === undefined) return;
  if (plugin.reconnecting) return plugin.reconnecting;
  plugin.reconnecting = (async () => {
    try {
      const runtime = await plugin.definition.create(plugin.config);
      const available = runtime.operations ?? plugin.definition.operations;
      operationDescriptors(available);
      if (typeof runtime.invoke !== "function" || available.some((operation) => !plugin.definition.operations.some((known) => known.name === operation.name && known.access === operation.access))) throw new Error("Web plugin runtime advertised an undeclared operation");
      plugin.runtime = { ...runtime, operations: available, invoke: runtime.invoke.bind(runtime) }; plugin.status = "ready";
    } catch { delete plugin.runtime; plugin.status = "unavailable"; }
  })();
  try { await plugin.reconnecting; } finally { delete plugin.reconnecting; }
}
export async function loadWebPlugins(selections: readonly WebPluginSelection[], home?: string): Promise<readonly LoadedWebPlugin[]> {
  const root = home ?? join(process.env.DIM_DATA_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "dim"), "web/runtime/current");
  const require = createRequire(join(root, "package.json"));
  const result: LoadedWebPlugin[] = [], packages = new Set<string>(), ids = new Set<string>();
  for (const selection of selections) {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(selection.package) || packages.has(selection.package)) throw new Error("invalid or duplicate installed Web plugin selection");
    packages.add(selection.package);
    // A configured plugin must be directly installed in the selected runtime;
    // Node's ancestor fallback must not borrow an unrelated or stale package.
    const directory = await realpath(join(root, "node_modules", selection.package));
    const entry = await realpath(require.resolve(selection.package));
    const within = relative(directory, entry);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("Web plugin entrypoint escapes its selected package");
    const module: unknown = await import(pathToFileURL(entry).href);
    const definition = typeof module === "object" && module !== null && "webPlugin" in module ? module.webPlugin as WebPlugin : undefined;
    if (!definition || !/^[a-z][a-z0-9-]{0,63}$/.test(definition.id) || ids.has(definition.id)
      || typeof definition.title !== "string" || definition.title.length > 128 || typeof definition.description !== "string" || definition.description.length > 2000
      || typeof definition.create !== "function" || !definition.assets || !Object.hasOwn(definition.assets, definition.browserEntry)) throw new Error("invalid or duplicate Web plugin definition");
    ids.add(definition.id); operationDescriptors(definition.operations);
    for (const [name, url] of Object.entries(definition.assets)) if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.(?:js|css|svg)$/.test(name) || !(url instanceof URL) || url.protocol !== "file:") throw new Error("invalid Web plugin asset declaration");
    const loaded: LoadedWebPlugin = { definition, ...(selection.config === undefined ? {} : { config: selection.config }), status: selection.config === undefined ? "unconfigured" : "unavailable" };
    await reconnectWebPlugin(loaded); result.push(loaded);
  }
  return result;
}
export function webPluginCatalog(plugins: readonly LoadedWebPlugin[], roles: readonly string[]) {
  return plugins.map(({ definition, runtime, config, status }) => ({ id: definition.id, title: definition.title, description: definition.description, status,
    configured: config !== undefined, browserEntry: `/v1/extensions/${definition.id}/assets/${definition.browserEntry}`,
    operations: operationDescriptors(runtime?.operations ?? []).filter(({ access }) => roles.includes(access)) }));
}
export async function invokeWebPlugin(plugin: LoadedWebPlugin, name: string, input: unknown, roles: readonly OperationAccess[]): Promise<unknown> {
  if (!plugin.runtime) throw new HttpResponseError(409, "This feature connection is not ready. Configure its private connection or reconnect the feature before retrying.");
  const operation = plugin.runtime.operations?.find((candidate) => candidate.name === name);
  if (!operation) throw new HttpResponseError(404, "operation not found");
  if (!roles.includes(operation.access)) throw new HttpResponseError(403, `${operation.access} authority required`);
  let parsed: unknown;
  try { parsed = operation.parseInput(input); } catch { throw new HttpResponseError(400, "The operation input is invalid. Check the selected target and fields."); }
  try { return operation.parseOutput(await plugin.runtime.invoke(name, parsed)); }
  catch { throw new HttpResponseError(409, "The connected feature could not complete this operation. Refresh its state before retrying; your form input is kept."); }
}
export async function serveWebPluginAsset(plugin: LoadedWebPlugin, name: string, response: ServerResponse): Promise<void> {
  const file = plugin.definition.assets[name];
  if (!file) throw new HttpResponseError(404, "asset not found");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > 512 * 1024) throw new Error("invalid Web plugin asset");
    const body = await handle.readFile();
    response.writeHead(200, { "Content-Type": name.endsWith(".css") ? "text/css; charset=utf-8" : name.endsWith(".svg") ? "image/svg+xml" : "text/javascript; charset=utf-8",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'" });
    response.end(body);
  } finally { await handle.close(); }
}
