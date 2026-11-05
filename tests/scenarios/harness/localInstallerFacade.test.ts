import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { installSelectedPlugins, selectedInstallerPluginInstall } from "../../../scripts/local-installer-facade.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
it("resolves the real published installer through its installed bin symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-selected-installer-")); roots.push(root);
  const built = resolve(import.meta.dirname, "../../../packages/installer/dist");
  const manifest = JSON.parse(await readFile(join(built, "package.json"), "utf8")) as { name: string; bin: { dim: string } };
  expect(manifest.name).toBe("@slop-lab/dim-installer");
  const prefix = join(root, "installers", "selected-artifact"), installed = join(prefix, "node_modules/@slop-lab/dim-installer");
  await cp(built, installed, { recursive: true });
  await mkdir(join(prefix, "node_modules/.bin"), { recursive: true });
  const facade = join(prefix, "node_modules/.bin/dim");
  await symlink(join(installed, manifest.bin.dim), facade);
  const selected = await selectedInstallerPluginInstall({ DIM_LOCAL_INSTALLER: facade });
  const owner = await import(pathToFileURL(join(installed, "pluginInstall.js")).href) as { installPlugins: unknown };
  expect(selected).toBe(owner.installPlugins);
  expect(await realpath(facade)).toBe(join(installed, manifest.bin.dim));
  await expect(installSelectedPlugins({ ...process.env, DIM_LOCAL_INSTALLER: facade }, [], { pluginHome: join(root, "untouched") })).rejects.toThrow("at least one plugin package is required");
});
it("requires an explicitly selected matching facade", async () => {
  await expect(selectedInstallerPluginInstall({})).rejects.toThrow("matching local installer facade");
});
