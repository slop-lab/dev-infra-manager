import { workspaceServiceSubdomain, readExternalUrlConfig } from "@slop-lab/dim-contracts-external-url";
import { UserError } from "@slop-lab/dim-host-core";
import { lifecycleOptions, workspacePluginRequest } from "@slop-lab/dim-host-core/controller";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";
import { externalUrlAdmin } from "./cli/controller-client.js";
import { ExternalUrlStore } from "./routeStore.js";

interface Dependencies {
  request: typeof workspacePluginRequest;
  approve(id: string): Promise<unknown>;
}
const defaults: Dependencies = { request: workspacePluginRequest, approve: (id) => externalUrlAdmin("url-approve", { id }) };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("External URL input must be an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, expression: RegExp): string {
  if (typeof value !== "string" || !expression.test(value)) throw new UserError("Invalid External URL input");
  return value;
}
const identifier = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** A Web adapter exposes workspace operations, never provider arguments or host credential paths. */
export async function invokeExternalUrlConsole(operation: string, raw: unknown, context: WorkspaceHostPluginContext, dependencies: Dependencies = defaults) {
  const input = object(raw);
  const extra = operation === "routes.create" ? ["ingress", "name", "port", "container", "protocol"]
    : operation === "routes.revoke" || operation === "routes.approve" ? ["id"] : [];
  if (!["routes.list", "routes.create", "routes.revoke", "routes.approve"].includes(operation)
    || Object.keys(input).some((key) => !["workspace", "workspaceId", ...extra].includes(key))) throw new UserError("Unknown External URL operation or fields");
  const workspace = await context.service.show(text(input.workspace, /^[a-z0-9][a-z0-9_.-]{0,47}$/));
  if (workspace.id !== text(input.workspaceId, identifier)) throw new UserError("Workspace was replaced; refresh before managing URLs");
  const config = await readExternalUrlConfig();
  const store = new ExternalUrlStore(lifecycleOptions().stateRoot);
  let entries: unknown[] = await store.list(workspace.id);
  function receipt(value: unknown): unknown[] {
    const urls = object(value).urls;
    if (!Array.isArray(urls)) throw new UserError("Invalid External URL receipt");
    return urls;
  }
  if (operation === "routes.create") {
    const ingress = text(input.ingress, /^[a-z0-9][a-z0-9-]{0,62}$/);
    const configured = config.ingresses[ingress];
    if (!configured) throw new UserError("External URL ingress is not configured on this host");
    const name = text(input.name, /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);
    const port = input.port;
    if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new UserError("External URL port must be from 1 to 65535");
    const container = input.container === undefined ? undefined : text(input.container, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
    const protocol = input.protocol ?? (configured.scheme === "tcp" ? "tcp" : "http");
    if (!["http", "https", "tcp"].includes(String(protocol))) throw new UserError("Invalid External URL target protocol");
    const accepted = receipt(await dependencies.request(workspace, "/api/urls", { method: "POST", body: { ingress, ...(configured.scheme === "tcp" ? {} : { subdomain: workspaceServiceSubdomain(workspace.name, name) }),
      target: { containers: container ? [container] : [], port, protocol } } }, context.signal));
    const ids = new Set(accepted.map((entry) => object(entry).id));
    entries = [...entries.filter((entry) => !ids.has(object(entry).id)), ...accepted];
  } else if (operation === "routes.revoke" || operation === "routes.approve") {
    const id = text(input.id, identifier);
    if (!entries.some((entry) => object(entry).id === id)) throw new UserError("Route is outside the selected workspace");
    if (operation === "routes.revoke") {
      await dependencies.request(workspace, `/api/urls/${id}`, { method: "DELETE" }, context.signal);
      entries = entries.filter((entry) => object(entry).id !== id);
    } else {
      const accepted = receipt(await dependencies.approve(id));
      entries = [...entries.filter((entry) => object(entry).id !== id), ...accepted];
    }
  } else entries = receipt(await dependencies.request(workspace, "/api/urls", { method: "GET" }, context.signal));
  // An accepted mutation uses its authoritative receipt, without a dependent refresh.
  const routes = entries.map((value) => {
    const entry = object(value), target = object(entry.target);
    return { id: entry.id, ingress: entry.ingress, url: entry.url,
      ...(entry.permalink ? { permalink: entry.permalink } : {}), approval: entry.approval,
      port: target.port, containers: target.containers, protocol: target.protocol };
  });
  return { workspace: workspace.name, workspaceId: workspace.id,
    ingresses: Object.entries(config.ingresses).map(([name, ingress]) => ({ name, description: ingress.description, scheme: ingress.scheme, driver: ingress.driver })), routes };
}
export async function runExternalUrlConsole(args: string[], context: WorkspaceHostPluginContext): Promise<void> {
  const values = args.filter((value) => value !== "--json");
  if (values.length !== 4 || values[0] !== "invoke" || values[2] !== "--input" || Buffer.byteLength(values[3]!, "utf8") > 4096) throw new UserError("usage: dim external-url console invoke OPERATION --input JSON --json");
  let input: unknown;
  try { input = JSON.parse(values[3]!) as unknown; } catch { throw new UserError("External URL input must be valid JSON"); }
  process.stdout.write(JSON.stringify(await invokeExternalUrlConsole(values[1]!, input, context)) + "\n");
}
