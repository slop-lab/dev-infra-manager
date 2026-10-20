import { access, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveHostPluginModule } from "@slop-lab/dim-host-core/workspace";
import { loadInstalledPlugins } from "../../../packages/host/core/src/controller/pluginLoader.js";
import { loadHostPlugins } from "../../../packages/cli/src/host-plugins.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("rejects real ancestor-package fallback in both loaders, while allowing an explicitly selected symlinked package and subpath", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-plugin-resolution-")); roots.push(root);
  const home = path.join(root, "runtime/current"), selected = path.join(root, "node_modules/@example/selected"), marker = path.join(root, "imported");
  await mkdir(home, { recursive: true }); await mkdir(selected, { recursive: true });
  await writeFile(path.join(selected, "package.json"), JSON.stringify({ name: "@example/selected", type: "module", exports: { ".": "./index.js", "./sub": "./sub.js" } }));
  const module = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'imported');
export const hostPlugin={name:'selected'};export default {name:'selected',apiVersion:4,register(){}};`;
  await writeFile(path.join(selected, "index.js"), module); await writeFile(path.join(selected, "sub.js"), module);
  await writeFile(path.join(home, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: ["@example/selected/sub"] }));
  vi.stubEnv("DIM_PLUGIN_HOME", home);
  // Establish that normal Node resolution really would execute the ambient dependency.
  expect(createRequire(path.join(home, "package.json")).resolve("@example/selected/sub")).toBe(path.join(selected, "sub.js"));
  await expect(loadHostPlugins()).rejects.toThrow(/not installed in/);
  await expect(loadInstalledPlugins(home)).rejects.toThrow(/not installed in/);
  await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  // pnpm/workspace linking selects a real package via a local node_modules entry.
  await mkdir(path.join(home, "node_modules/@example"), { recursive: true });
  await symlink(selected, path.join(home, "node_modules/@example/selected"), "dir");
  expect(await resolveHostPluginModule(home, "@example/selected/sub")).toBe(await realpath(path.join(selected, "sub.js")));
  expect((await loadHostPlugins()).map(({ name }) => name)).toEqual(["selected"]);
  const controller = await loadInstalledPlugins(home);
  expect(controller.registered.plugins).toContain("selected"); await controller.registered.dispose();
  await access(marker);
});

it("accepts direct installed packages and explicit operator module paths without borrowing another package entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-plugin-direct-")); roots.push(root);
  const selected = path.join(root, "node_modules/plain-plugin"); await mkdir(selected, { recursive: true });
  await writeFile(path.join(selected, "package.json"), JSON.stringify({ name: "plain-plugin", type: "module", main: "index.js" }));
  const entry = path.join(selected, "index.js"); await writeFile(entry, "export const hostPlugin={name:'plain'};");
  expect(await resolveHostPluginModule(root, "plain-plugin")).toBe(entry);
  expect(await resolveHostPluginModule(root, entry)).toBe(entry);
  expect(await resolveHostPluginModule(root, pathToFileURL(entry).href)).toBe(entry);
  expect(await resolveHostPluginModule(root, "./node_modules/plain-plugin/index.js")).toBe(entry);
  const outside = path.join(root, "node_modules/outside-plugin"); await mkdir(outside);
  await writeFile(path.join(outside, "package.json"), JSON.stringify({ name: "outside-plugin", type: "module", main: "../outside.js" }));
  await writeFile(path.join(root, "node_modules/outside.js"), "throw Error('must not import outside selected package');");
  await expect(resolveHostPluginModule(root, "outside-plugin")).rejects.toThrow(/outside its installed package/);
});


it("loads the selected immutable release after runtime/current changes in the same process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-plugin-release-")); roots.push(root);
  const releases = [path.join(root, "release-one"), path.join(root, "release-two")];
  for (const [index, release] of releases.entries()) {
    const selected = path.join(release, "node_modules/@example/update"); await mkdir(selected, { recursive: true });
    await writeFile(path.join(selected, "package.json"), JSON.stringify({ name: "@example/update", type: "module", exports: "./index.js" }));
    await writeFile(path.join(selected, "index.js"), `export const hostPlugin={name:'release-${index}'};export default {name:'release-${index}',apiVersion:4,register(){}};`);
    await writeFile(path.join(release, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: ["@example/update"] }));
  }
  const current = path.join(root, "current"); await symlink(releases[0]!, current, "dir");
  vi.stubEnv("DIM_PLUGIN_HOME", current);
  for (let index = 0; index < releases.length; index++) {
    if (index !== 0) {
      const next = path.join(root, "next"); await symlink(releases[index]!, next, "dir"); await rename(next, current);
    }
    expect(await resolveHostPluginModule(current, "@example/update")).toBe(path.join(releases[index]!, "node_modules/@example/update/index.js"));
    expect((await loadHostPlugins()).map(({ name }) => name)).toEqual([`release-${index}`]);
    const controller = await loadInstalledPlugins(current);
    expect(controller.registered.plugins).toContain(`release-${index}`); await controller.registered.dispose();
  }
});
