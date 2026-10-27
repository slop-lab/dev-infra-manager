import { createHash } from "node:crypto";
import { object, parseModel, privateFile, type RouterAccount, type RouterConfig, type RouterModel, type RouterRoute } from "./config.js";
import { ensureManagedBackend, configureManagedAccountModels, managedAccountDiscovery } from "./managed-backend.js";

const catalogs = new Map<string, { readonly identity: string; readonly expires: number; readonly pending: Promise<RouterModel[]> }>();
const catalogLifetime = 30_000;
const maximumBytes = 4 * 1024 * 1024;
type DiscoveryMode = "inspection" | "preparation";

function accountScope(config: RouterConfig, account: RouterAccount): string {
  return JSON.stringify([config.stateDirectory, account.id, account.endpoint, account.keyFile, account.provider]);
}
async function discoveryContext(config: RouterConfig, account: RouterAccount): Promise<{ readonly endpoint: string; readonly headers: Record<string, string>; readonly identity: string; readonly direct: boolean }> {
  const direct = await managedAccountDiscovery(config, account);
  const endpoint = direct?.endpoint ?? account.endpoint + "/v1/models";
  const headers = direct?.headers ?? { authorization: `Bearer ${(await privateFile(account.keyFile, 16 * 1024)).trim()}` };
  const identity = createHash("sha256").update(JSON.stringify([endpoint, Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))])).digest("hex");
  return { endpoint, headers, identity, direct: direct !== undefined };
}
async function discoverAccountCatalog(config: RouterConfig, account: RouterAccount, mode: DiscoveryMode = "preparation"): Promise<{ readonly models: RouterModel[]; readonly identity: string; readonly scope: string }> {
  const scope = JSON.stringify([mode, accountScope(config, account)]), context = await discoveryContext(config, account);
  const cached = catalogs.get(scope);
  if (cached && cached.identity === context.identity && cached.expires > Date.now()) return { models: await cached.pending, identity: context.identity, scope };
  const pending = discover(config, account, context, mode);
  const entry = { identity: context.identity, expires: Date.now() + catalogLifetime, pending };
  catalogs.set(scope, entry);
  try { return { models: await pending, identity: context.identity, scope }; }
  catch (error) { if (catalogs.get(scope) === entry) catalogs.delete(scope); throw error; }
}

/** Discovery is credential scoped; an all-model route never authorizes arbitrary model names. */
export async function discoverAccountModels(config: RouterConfig, account: RouterAccount): Promise<RouterModel[]> {
  return (await discoverAccountCatalog(config, account)).models;
}
export async function inspectAccountModels(config: RouterConfig, account: RouterAccount): Promise<RouterModel[]> {
  return (await discoverAccountCatalog(config, account, "inspection")).models;
}
async function discover(config: RouterConfig, account: RouterAccount, context: { readonly endpoint: string; readonly headers: Record<string, string>; readonly direct: boolean }, mode: DiscoveryMode): Promise<RouterModel[]> {
  const request = () => fetch(context.endpoint, { headers: context.headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
  let response: Response;
  try { response = await request(); }
  catch (error) {
    if (mode === "inspection" || context.direct || !account.provider) throw error;
    // A separate operator listener may discover a worker already owned by inference.
    // Start a worker only when its existing listener cannot be reached.
    await ensureManagedBackend(config, account); response = await request();
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("account model discovery is unavailable; use an explicit model list if the provider has no model catalog"); }
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maximumBytes) throw new Error("account model catalog exceeds its size bound");
      chunks.push(chunk);
    }
  } catch (error) { await response.body.cancel().catch(() => {}); throw error; }
  const value = object(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  if (!Array.isArray(value.data) || value.data.length > 10_000) throw new Error("invalid account model catalog");
  if (value.has_more === true || value.next_page || value.next_cursor) throw new Error("paginated provider model catalogs require an explicit model list");
  const models = value.data.map((raw: unknown): RouterModel => {
    const row = object(raw);
    // Preserve unknown limits: clients may have authoritative model metadata of their own.
    return parseModel({ id: row.id, name: row.name ?? row.display_name ?? row.id,
      api: row.api ?? (account.provider === "openai" || account.provider === "anthropic" ? "chat" : "responses"),
      context: row.context ?? row.context_length ?? row.context_window ?? row.max_input_tokens,
      output: row.output ?? row.max_output_tokens });
  });
  if (!models.length || new Set(models.map(({ id }) => id)).size !== models.length) throw new Error("account model catalog is empty or contains duplicate models");
  if (context.direct && mode === "preparation") {
    const explicit = config.routes.filter((route) => route.accountId === account.id && route.models !== "all").flatMap(({ models }) => models === "all" ? [] : models);
    await configureManagedAccountModels(config, account, [...new Map([...explicit, ...models].map((model) => [model.id, model])).values()]);
  }
  return models;
}
export async function resolveRouteModels(config: RouterConfig, route: RouterRoute): Promise<RouterModel[]> {
  if (route.models !== "all") return route.models;
  const account = config.accounts.find(({ id }) => id === route.accountId);
  if (!account) throw new Error("route account is unavailable");
  if (!account.supportedModels) throw new RouteModelInventoryError("all-model route publication requires the account's registered supportedModels inventory; run route.upsert again or configure supportedModels explicitly");
  return account.supportedModels;
}
export class RouteModelInventoryError extends Error {}
export async function authorizeRouteModel(config: RouterConfig, route: RouterRoute, id: unknown, api: RouterModel["api"]): Promise<RouterModel | undefined> {
  return (await resolveRouteModels(config, route)).find((model) => model.id === id && model.api === api);
}
