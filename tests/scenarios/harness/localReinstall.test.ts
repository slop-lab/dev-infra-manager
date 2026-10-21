import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { confirmRemoval, selectCacheRetention, type Questions } from "../../../scripts/local-uninstall/prompts.ts";
import { cacheRestoreArtifacts, cacheRestoreSelection, restoreCaches } from "../../../scripts/local-uninstall/restore-caches.ts";
import { removalPaths } from "../../../scripts/local-uninstall/paths.ts";
import type { Command } from "../../../scripts/local-uninstall/command.ts";
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
function questions(answers: string[], tty = true) {
  const prompts: string[] = [];
  const input: Questions = { tty, async ask(question) { prompts.push(question); const next = answers.shift(); if (next === undefined) throw new Error("unexpected prompt"); return next; } };
  return { input, prompts };
}
it("defaults terminal cache retention to yes and destructive confirmation to no", async () => {
  const q = questions(["", ""]);
  expect(await selectCacheRetention({}, q.input)).toBe(true);
  expect(await confirmRemoval({}, q.input)).toBe(false);
  expect(q.prompts).toEqual([expect.stringContaining("[Y/n]"), expect.stringContaining("[y/N]")]);
  const explicit = questions(["invalid", "no", "YES"]);
  expect(await selectCacheRetention({}, explicit.input)).toBe(false);
  expect(await confirmRemoval({}, explicit.input)).toBe(true);
});
it("honors explicit cache choices and -y without prompts; dry runs and nonterminals never confirm implicitly", async () => {
  const q = questions([]);
  expect(await selectCacheRetention({ yes: true }, q.input)).toBe(true);
  expect(await confirmRemoval({ yes: true }, q.input)).toBe(true);
  expect(await selectCacheRetention({ yes: true, noKeepCacheData: true }, q.input)).toBe(false);
  expect(await selectCacheRetention({ keepCacheData: true }, q.input)).toBe(true);
  expect(await confirmRemoval({ dryRun: true, yes: true }, q.input)).toBe(false);
  expect(await selectCacheRetention({ dryRun: true }, q.input)).toBe(true);
  const pipe = questions([], false);
  expect(await selectCacheRetention({}, pipe.input)).toBe(true);
  expect(await confirmRemoval({}, pipe.input)).toBe(false);
  expect(q.prompts).toEqual([]); expect(pipe.prompts).toEqual([]);
  await expect(selectCacheRetention({ keepCacheData: true, noKeepCacheData: true }, q.input)).rejects.toThrow("only one");
});
async function fixture(kinds: readonly string[], mirrors: boolean) {
  const home = await mkdtemp(join(tmpdir(), "dim-local-reinstall-")); cleanup.push(home);
  const paths = removalPaths({ HOME: home, XDG_RUNTIME_DIR: join(home, "run") });
  const resourceIds: Record<string, string> = { network: "n".repeat(43) };
  for (const [index, kind] of kinds.entries()) { resourceIds[`cache:${kind}`] = String(index + 1).repeat(43); resourceIds[`data:${kind}`] = String(index + 5).repeat(43); }
  const ledger = { schemaVersion: 2, serviceId: "s".repeat(43), resourceIds };
  const ledgerFile = join(paths.state, "plugins/cache-server/services/cache-dim-cache.json");
  await mkdir(dirname(ledgerFile), { recursive: true }); if (kinds.length) await writeFile(ledgerFile, JSON.stringify(ledger));
  await mkdir(paths.hostPlugins, { recursive: true }); await writeFile(join(paths.hostPlugins, "plugins.json"), JSON.stringify({ plugins: mirrors ? ["@slop-lab/dim-host-plugin-mirrors"] : [] }));
  const bundle = join(home, "bundle"); await mkdir(bundle);
  const packages = [{ name: "@slop-lab/dim-cli", version: "0.10.0", file: "cli.tgz" }, { name: "@slop-lab/dim-installer", version: "0.10.0", file: "installer.tgz" }, ...["cache-server", "mirrors"].map((name) => ({ name: `@slop-lab/dim-host-plugin-${name}`, version: "0.10.0", file: `${name}.tgz` }))];
  await writeFile(join(bundle, "packages.json"), JSON.stringify({ packages })); await writeFile(join(bundle, "installer.tgz"), "reviewed-source-installer");
  return { paths, bundle, ledger, ledgerFile, packages };
}
it.each([["npm", "apt"], ["docker", "npm", "pypi", "apt"]])("restores the prior cache subset in install, ensure, mirrors order: %j", async (...kinds: string[]) => {
  const f = await fixture(kinds, true), selection = await cacheRestoreSelection(f.paths), prepared = await cacheRestoreArtifacts(f.bundle, selection, f.paths);
  expect(selection.kinds).toEqual([...kinds].sort()); expect(selection.mirrors).toBe(true);
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: Command = async (file, args) => { calls.push({ file, args }); return { status: 0, stdout: "", stderr: "" }; };
  await rm(f.ledgerFile); // Retained identity can be re-established after installation before any cache starts.
  await restoreCaches(selection, true, f.paths, f.bundle, prepared.facade, prepared.plugins, run);
  expect(calls).toEqual([
    { file: prepared.facade, args: ["installer", "install", "plugin", "--local-packages", f.bundle, "@slop-lab/dim-host-plugin-cache-server@0.10.0", "@slop-lab/dim-host-plugin-mirrors@0.10.0"] },
    { file: prepared.facade, args: ["cache-server", "ensure", ...[...kinds].sort()] },
    { file: prepared.facade, args: ["mirrors", "ensure"] }
  ]);
  expect(JSON.parse(await readFile(f.ledgerFile, "utf8"))).toEqual(f.ledger);
});
it("does nothing when caches were unused and does not add unselected mirrors", async () => {
  const f = await fixture([], true), empty = await cacheRestoreSelection(f.paths);
  const invoked: string[][] = [];
  const run: Command = async (_file, args) => { invoked.push([...args]); return { status: 0, stdout: "", stderr: "" }; };
  await restoreCaches(empty, true, f.paths, f.bundle, "/unused", [], run); expect(invoked).toEqual([]);
  const selected = await fixture(["npm"], false), selection = await cacheRestoreSelection(selected.paths), prepared = await cacheRestoreArtifacts(selected.bundle, selection, selected.paths);
  await restoreCaches(selection, false, selected.paths, selected.bundle, prepared.facade, prepared.plugins, run);
  expect(invoked).toHaveLength(2); expect(prepared.plugins).toEqual(["@slop-lab/dim-host-plugin-cache-server@0.10.0"]);
});
it("rejects missing or mismatched restoration packages during preflight", async () => {
  const f = await fixture(["npm"], true), selection = await cacheRestoreSelection(f.paths);
  await writeFile(join(f.bundle, "packages.json"), JSON.stringify({ packages: f.packages.filter(({ name }) => !name.endsWith("-mirrors")) }));
  await expect(cacheRestoreArtifacts(f.bundle, selection, f.paths)).rejects.toThrow("lacks matching @slop-lab/dim-host-plugin-mirrors");
  await writeFile(join(f.bundle, "packages.json"), JSON.stringify({ packages: f.packages.map((entry) => entry.name.endsWith("-cache-server") ? { ...entry, version: "0.9.0" } : entry) }));
  await expect(cacheRestoreArtifacts(f.bundle, selection, f.paths)).rejects.toThrow("lacks matching @slop-lab/dim-host-plugin-cache-server");
});
