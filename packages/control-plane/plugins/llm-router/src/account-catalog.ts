import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tryAcquireKernelGuard } from "@slop-lab/dim-control-plane-core/lock";
import { object, parseConfig, parseModel, privateFile, type RouterAccount, type RouterConfig, type RouterModel, type RouterRoute } from "./config.js";
import { discoverAccountModels } from "./model-catalog.js";
import { createManagedAccount, configureManagedAccountModels } from "./managed-backend.js";

interface Catalog { schemaVersion: 2; accounts: RouterAccount[]; routes: RouterRoute[]; supportedModels: Record<string, RouterModel[]> }
function catalogPath(config: RouterConfig): string { return join(config.stateDirectory, "account-catalog.json"); }
function effectiveAccounts(config: RouterConfig, catalog: Catalog): RouterAccount[] {
  return [...config.accounts, ...catalog.accounts].map((account) => {
    const supportedModels = Object.hasOwn(catalog.supportedModels, account.id) ? catalog.supportedModels[account.id] : undefined;
    return supportedModels === undefined ? account : { ...account, supportedModels };
  });
}
function withoutSupportedModels(account: RouterAccount): RouterAccount {
  const result = { ...account }; delete result.supportedModels; return result;
}
async function readCatalog(config: RouterConfig, upgrade = true): Promise<Catalog> {
  let value: unknown;
  try { value = JSON.parse(await privateFile(catalogPath(config), 4 * 1024 * 1024)); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { schemaVersion: 2, accounts: [], routes: [], supportedModels: {} }; throw error; }
  const row = object(value);
  const legacy = row.schemaVersion === 1 && Object.keys(row).sort().join() === "accounts,routes,schemaVersion";
  const current = row.schemaVersion === 2 && Object.keys(row).sort().join() === "accounts,routes,schemaVersion,supportedModels";
  if ((!legacy && !current) || !Array.isArray(row.accounts) || !Array.isArray(row.routes)) throw new Error("invalid router account catalog");
  const supportedModels = Object.fromEntries(Object.entries(legacy ? {} : object(row.supportedModels)).map(([accountId, raw]) => {
    if (!Array.isArray(raw) || !raw.length || raw.length > 10_000) throw new Error("invalid router supported model inventory");
    const models = raw.map(parseModel);
    if (new Set(models.map(({ id }) => id)).size !== models.length) throw new Error("duplicate router supported model");
    return [accountId, models];
  }));
  const savedRoutes = row.routes;
  const accounts = [...config.accounts, ...row.accounts].map((raw) => {
    const account = object(raw), models = typeof account.id === "string" && Object.hasOwn(supportedModels, account.id) ? supportedModels[account.id] : undefined;
    return models === undefined ? account : { ...account, supportedModels: models };
  });
  if (Object.keys(supportedModels).some((id) => !accounts.some((account) => account.id === id))) throw new Error("supported model inventory refers to an unknown account");
  const effective = parseConfig({ ...config, accounts, routes: [...config.routes.filter(({ id }) => !savedRoutes.some((candidate: unknown) => object(candidate).id === id)), ...row.routes] });
  const catalog: Catalog = { schemaVersion: 2, accounts: effective.accounts.filter(({ id }) => !config.accounts.some((account) => account.id === id)).map(withoutSupportedModels),
    routes: effective.routes.filter(({ id }) => savedRoutes.some((candidate: unknown) => object(candidate).id === id)), supportedModels };
  if (legacy && upgrade) await upgradeLegacyCatalog(config);
  return catalog;
}
async function upgradeLegacyCatalog(config: RouterConfig): Promise<void> {
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const guard = await tryAcquireKernelGuard(join(config.stateDirectory, "account-catalog.guard"), { timeoutMilliseconds: 5000 });
  if (!guard) throw new Error("account catalog is busy; retry");
  const temporary = join(config.stateDirectory, `account-catalog.${randomUUID()}.tmp`);
  try {
    const current = object(JSON.parse(await privateFile(catalogPath(config), 4 * 1024 * 1024)));
    if (current.schemaVersion === 2 && Object.keys(current).sort().join() === "accounts,routes,schemaVersion,supportedModels") return;
    if (current.schemaVersion !== 1 || Object.keys(current).sort().join() !== "accounts,routes,schemaVersion"
      || !Array.isArray(current.accounts) || !Array.isArray(current.routes)) throw new Error("invalid legacy router account catalog");
    await writeFile(temporary, JSON.stringify({ schemaVersion: 2, accounts: current.accounts, routes: current.routes, supportedModels: {} }) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, catalogPath(config));
  } finally { await rm(temporary, { force: true }); await guard.release(); }
}
/** Every request reads a single atomic catalog snapshot. Accounts and route bindings stay distinct. */
export async function effectiveRouterConfig(config: RouterConfig): Promise<RouterConfig> {
  const catalog = await readCatalog(config);
  return { ...config, accounts: effectiveAccounts(config, catalog), routes: [...config.routes.filter(({ id }) => !catalog.routes.some((route) => route.id === id)), ...catalog.routes] };
}
async function changeCatalog<T>(config: RouterConfig, update: (catalog: Catalog) => Promise<T>): Promise<T> {
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const guard = await tryAcquireKernelGuard(join(config.stateDirectory, "account-catalog.guard"), { timeoutMilliseconds: 5000 });
  if (!guard) throw new Error("account catalog is busy; retry");
  const temporary = join(config.stateDirectory, `account-catalog.${randomUUID()}.tmp`);
  try {
    const catalog = await readCatalog(config, false), result = await update(catalog);
    // Validate the entire resulting graph before publishing the atomic snapshot.
    parseConfig({ ...config, accounts: effectiveAccounts(config, catalog), routes: [...config.routes.filter(({ id }) => !catalog.routes.some((route) => route.id === id)), ...catalog.routes] });
    await writeFile(temporary, JSON.stringify(catalog) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, catalogPath(config)); return result;
  } finally { await rm(temporary, { force: true }); await guard.release(); }
}
export function defaultAccountReference(provider: "codex" | "openai" | "anthropic"): string { return { codex: "Codex", openai: "OpenAI compatible API", anthropic: "Anthropic compatible API" }[provider]; }
export async function addRouterAccount(config: RouterConfig, input: { accountId?: string; reference?: string; provider: "codex" | "openai" | "anthropic"; endpoint?: string; apiKey?: string }): Promise<RouterAccount> {
  let created: RouterAccount | undefined;
  try {
    return await changeCatalog(config, async (catalog) => {
      const accountId = input.accountId ?? `${input.provider}-${randomUUID()}`;
      const reference = input.reference ?? defaultAccountReference(input.provider);
      if ([...config.accounts, ...catalog.accounts].some(({ id }) => id === accountId)) throw new Error("account already exists");
      const account = await createManagedAccount({ ...config, accounts: [...config.accounts, ...catalog.accounts] }, { ...input, accountId, reference });
      created = account; catalog.accounts.push(account); return account;
    });
  } catch (error) {
    if (created) {
      const account = created;
      // An uncertain publication must retain its partition rather than deleting live credentials.
      const published = await readCatalog(config).then((catalog) => catalog.accounts.some(({ id }) => id === account.id)).catch(() => true);
      if (!published) await rm(join(config.stateDirectory, "managed-accounts", account.id), { recursive: true, force: true });
    }
    throw error;
  }
}

/** Labels are mutable; account IDs, credential partitions and usage attribution are not. */
export async function renameRouterAccount(config: RouterConfig, accountId: string, reference: string): Promise<RouterAccount> {
  if (!reference.trim() || reference.trim().length > 200) throw new Error("account label requires 1 to 200 characters");
  return changeCatalog(config, async (catalog) => {
    const account = catalog.accounts.find(({ id }) => id === accountId);
    if (!account) throw new Error("managed account was not found; configuration accounts must be renamed in their configuration");
    account.reference = reference.trim(); return account;
  });
}

export async function upsertRouterRoute(config: RouterConfig, route: RouterRoute): Promise<RouterRoute> {
  return changeCatalog(config, async (catalog) => {
    let account = effectiveAccounts(config, catalog).find(({ id }) => id === route.accountId);
    if (!account) throw new Error("account was not found");
    const allRoutes = [...config.routes.filter(({ id }) => !catalog.routes.some((candidate) => candidate.id === id) && id !== route.id), ...catalog.routes.filter(({ id }) => id !== route.id), route];
    if (route.models === "all") {
      const models = await discoverAccountModels({ ...config, accounts: effectiveAccounts(config, catalog), routes: allRoutes }, account);
      catalog.supportedModels[account.id] = models;
      account = { ...account, supportedModels: models };
    }
    catalog.routes = [...catalog.routes.filter(({ id }) => id !== route.id), route];
    parseConfig({ ...config, accounts: effectiveAccounts(config, catalog), routes: allRoutes });
    if (account.provider && account.provider !== "codex") {
      const accountRoutes = allRoutes.filter(({ accountId }) => accountId === account.id);
      const explicit = accountRoutes.flatMap(({ models }) => models === "all" ? [] : models);
      const models = [...new Map([...explicit, ...(account.supportedModels ?? [])].map((model) => [model.id, model])).values()];
      await configureManagedAccountModels(config, account, models);
    }
    return route;
  });
}
