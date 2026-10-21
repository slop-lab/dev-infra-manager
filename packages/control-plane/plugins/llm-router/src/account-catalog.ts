import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tryAcquireKernelGuard } from "@slop-lab/dim-control-plane-core/lock";
import { object, parseConfig, privateFile, type RouterAccount, type RouterConfig, type RouterRoute } from "./config.js";
import { createManagedAccount, configureManagedAccountModels } from "./managed-backend.js";

interface Catalog { schemaVersion: 1; accounts: RouterAccount[]; routes: RouterRoute[] }
function catalogPath(config: RouterConfig): string { return join(config.stateDirectory, "account-catalog.json"); }
async function readCatalog(config: RouterConfig): Promise<Catalog> {
  let value: unknown;
  try { value = JSON.parse(await privateFile(catalogPath(config), 4 * 1024 * 1024)); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { schemaVersion: 1, accounts: [], routes: [] }; throw error; }
  const row = object(value);
  if (row.schemaVersion !== 1 || Object.keys(row).sort().join() !== "accounts,routes,schemaVersion" || !Array.isArray(row.accounts) || !Array.isArray(row.routes)) throw new Error("invalid router account catalog");
  const savedRoutes = row.routes;
  const effective = parseConfig({ ...config, accounts: [...config.accounts, ...row.accounts], routes: [...config.routes.filter(({ id }) => !savedRoutes.some((candidate: unknown) => object(candidate).id === id)), ...row.routes] });
  return { schemaVersion: 1, accounts: effective.accounts.filter(({ id }) => !config.accounts.some((account) => account.id === id)), routes: effective.routes.filter(({ id }) => savedRoutes.some((candidate: unknown) => object(candidate).id === id)) };
}
/** Every request reads a single atomic catalog snapshot. Accounts and route bindings stay distinct. */
export async function effectiveRouterConfig(config: RouterConfig): Promise<RouterConfig> {
  const catalog = await readCatalog(config);
  return { ...config, accounts: [...config.accounts, ...catalog.accounts], routes: [...config.routes.filter(({ id }) => !catalog.routes.some((route) => route.id === id)), ...catalog.routes] };
}
async function changeCatalog<T>(config: RouterConfig, update: (catalog: Catalog) => Promise<T>): Promise<T> {
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const guard = await tryAcquireKernelGuard(join(config.stateDirectory, "account-catalog.guard"), { timeoutMilliseconds: 5000 });
  if (!guard) throw new Error("account catalog is busy; retry");
  const temporary = join(config.stateDirectory, `account-catalog.${randomUUID()}.tmp`);
  try {
    const catalog = await readCatalog(config), result = await update(catalog);
    // Validate the entire resulting graph before publishing the atomic snapshot.
    parseConfig({ ...config, accounts: [...config.accounts, ...catalog.accounts], routes: [...config.routes.filter(({ id }) => !catalog.routes.some((route) => route.id === id)), ...catalog.routes] });
    await writeFile(temporary, JSON.stringify(catalog) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, catalogPath(config)); return result;
  } finally { await rm(temporary, { force: true }); await guard.release(); }
}
export async function addRouterAccount(config: RouterConfig, input: { accountId: string; reference: string; provider: "codex" | "openai" | "anthropic"; endpoint?: string; apiKey?: string }): Promise<RouterAccount> {
  let created: RouterAccount | undefined;
  try {
    return await changeCatalog(config, async (catalog) => {
      if ([...config.accounts, ...catalog.accounts].some(({ id }) => id === input.accountId)) throw new Error("account already exists");
      const account = await createManagedAccount({ ...config, accounts: [...config.accounts, ...catalog.accounts] }, input);
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

export async function upsertRouterRoute(config: RouterConfig, route: RouterRoute): Promise<RouterRoute> {
  return changeCatalog(config, async (catalog) => {
    const account = [...config.accounts, ...catalog.accounts].find(({ id }) => id === route.accountId);
    if (!account) throw new Error("account was not found");
    catalog.routes = [...catalog.routes.filter(({ id }) => id !== route.id), route];
    parseConfig({ ...config, accounts: [...config.accounts, ...catalog.accounts], routes: [...config.routes.filter(({ id }) => !catalog.routes.some((candidate) => candidate.id === id)), ...catalog.routes] });
    if (account.provider && account.provider !== "codex") {
      const allRoutes = [...config.routes.filter(({ id }) => !catalog.routes.some((candidate) => candidate.id === id)), ...catalog.routes];
      const models = allRoutes.filter(({ accountId }) => accountId === account.id).flatMap(({ models }) => models);
      await configureManagedAccountModels(config, account, models);
    }
    return route;
  });
}
