import { mkdir, writeFile, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { jsonFiles, object, readJson, text } from "./files.ts";
import type { RemovalPaths } from "./types.ts";
import { checked, type Command } from "./command.ts";
export interface CacheRestore { readonly kinds: readonly string[]; readonly mirrors: boolean; readonly ledger?: Record<string, unknown> }
export async function cacheRestoreSelection(paths: RemovalPaths): Promise<CacheRestore> {
  const kinds = new Set<string>(); let ledger: Record<string, unknown> | undefined;
  for (const root of new Set([paths.state, paths.managed])) for (const file of await jsonFiles(join(root, "plugins/cache-server/services"))) {
    if (basename(file) !== "cache-dim-cache.json") throw new Error("automatic cache restore requires the standard cache-server namespace");
    const value = object(await readJson(file));
    if (ledger && JSON.stringify(ledger) !== JSON.stringify(value)) throw new Error("conflicting cache-server ownership ledgers");
    ledger = value;
    for (const role of Object.keys(object(value.resourceIds))) if (/^(?:cache|data):/.test(role)) kinds.add(role.slice(role.indexOf(":") + 1));
  }
  const manifest = await readJson(join(paths.hostPlugins, "plugins.json"));
  const plugins = manifest === undefined ? [] : object(manifest).plugins;
  if (!Array.isArray(plugins)) throw new Error("invalid installed host plugin selection");
  return { kinds: [...kinds].sort(), mirrors: plugins.includes("@slop-lab/dim-host-plugin-mirrors"), ...(ledger ? { ledger } : {}) };
}
export async function cacheRestoreArtifacts(bundle: string, selection: CacheRestore, paths: RemovalPaths): Promise<{ facade: string; plugins: string[] }> {
  const entries = object(await readJson(join(bundle, "packages.json"))).packages;
  if (!Array.isArray(entries)) throw new Error("invalid prepared package bundle");
  const records = entries.map(object), cli = records.find((entry) => entry.name === "@slop-lab/dim-cli"), installer = records.find((entry) => entry.name === "@slop-lab/dim-installer");
  if (!installer || !cli) throw new Error("prepared bundle lacks installer/core");
  const version = text(cli.version), file = text(installer.file);
  if (basename(file) !== file) throw new Error("unsafe installer artifact path");
  const required = selection.kinds.length ? ["@slop-lab/dim-host-plugin-cache-server", ...(selection.mirrors ? ["@slop-lab/dim-host-plugin-mirrors"] : [])] : [];
  for (const name of required) if (!records.some((entry) => entry.name === name && entry.version === version)) throw new Error(`prepared bundle lacks matching ${name}`);
  const hash = createHash("sha256").update(await readFile(join(bundle, file))).digest("hex");
  return { facade: join(paths.data, "installers", hash, "node_modules/.bin/dim"), plugins: required.map((name) => `${name}@${version}`) };
}
export async function restoreCaches(selection: CacheRestore, keepData: boolean, paths: RemovalPaths, bundle: string, facade: string, plugins: readonly string[], run: Command): Promise<void> {
  if (!selection.kinds.length) return;
  if (keepData && selection.ledger) {
    const file = join(paths.state, "plugins/cache-server/services/cache-dim-cache.json"), current = await readJson(file);
    if (current && JSON.stringify(current) !== JSON.stringify(selection.ledger)) throw new Error("cache ownership changed during reinstall");
    if (!current) { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, JSON.stringify(selection.ledger), { mode: 0o600, flag: "wx" }); }
  }
  await checked(run, facade, ["installer", "install", "plugin", "--local-packages", bundle, ...plugins]);
  await checked(run, facade, ["cache-server", "ensure", ...selection.kinds]);
  if (selection.mirrors) await checked(run, facade, ["mirrors", "ensure"]);
  console.log(`Restored local caches: ${selection.kinds.join(", ")}${selection.mirrors ? " and workspace mirror connections" : ""}`);
}
