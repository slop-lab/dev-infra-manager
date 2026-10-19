import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { installPlugins, defaultControlPlanePluginHome, defaultPluginHome } from "../../../../core/packages/installer/src/install.js";
import { installerCommand } from "../../../../core/packages/installer/src/installerCommands.js";

const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "dim-cp-plugin-")); roots.push(root);
  const home = path.join(root, "runtime", "current");
  const pack = async (name: string, source: string, extra: Record<string, unknown> = {}) => {
    const directory = path.join(root, name.replaceAll("/", "-")); await mkdir(directory);
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "0.10.0", type: "module", exports: { ".": { import: "./index.js", default: "./index.js" } }, ...extra }));
    await writeFile(path.join(directory, "index.js"), `// @ts-check\n${source}\n`);
    const result = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: directory });
    const output: unknown = JSON.parse(result.stdout);
    const entry: unknown = Array.isArray(output) ? output[0] : undefined;
    if (!entry || typeof entry !== "object" || !("filename" in entry) || typeof entry.filename !== "string") throw new Error("npm pack returned no filename");
    return path.join(root, entry.filename);
  };
  const runtime = await pack("@slop-lab/dim-control-plane", "export const runtime = true;", { bin: { "dim-control-plane": "bin.mjs" } });
  // Include a real executable in a separate runtime package, not a host CLI stub.
  const directory = path.join(root, "@slop-lab-dim-control-plane");
  await writeFile(path.join(directory, "bin.mjs"), '#!/usr/bin/env node\n// @ts-check\nconsole.log("control-plane fixture");\n', { mode: 0o755 });
  await exec("npm", ["pack", "--ignore-scripts", "--pack-destination", root], { cwd: directory });
  const cp = await pack("test-control-plane", "export const controlPlanePlugin = { apiVersion: 1, name: 'test', configure() { throw new Error('must not configure at installation'); } };");
  const host = await pack("test-host", "export const hostPlugin = { name: 'test' };");
  return { root, home, runtime, cp, host, pack };
}

it("installs a standalone executable and only CP plugins, without a configured CLI; lifecycle commands share that target", async () => {
  const f = await fixture();
  vi.stubEnv("DIM_CONFIG_PATH", path.join(f.root, "no-cli.json"));
  vi.stubEnv("DIM_CONTROL_PLANE_PLUGIN_HOME", f.home);
  const installed = await installPlugins([f.cp], { pluginHome: f.home, target: "control-plane", runtimeSpecifier: f.runtime });
  expect(installed).toEqual(["test-control-plane"]);
  const pkg = JSON.parse(await readFile(path.join(f.home, "package.json"), "utf8"));
  expect(Object.keys(pkg.dependencies).sort()).toEqual(["@slop-lab/dim-control-plane", "test-control-plane"]);
  expect((await exec(path.join(f.home, "node_modules/.bin/dim-control-plane"))).stdout.trim()).toBe("control-plane fixture");
  const manifest = async () => JSON.parse(await readFile(path.join(f.home, "plugins.json"), "utf8"));
  expect(await manifest()).toEqual({ schemaVersion: 1, plugins: ["test-control-plane"] });
  await installerCommand(["control-plane", "disable-plugin", "test-control-plane"]);
  expect((await manifest()).plugins).toEqual([]);
  await installerCommand(["control-plane", "enable-plugin", "test-control-plane"]);
  expect((await manifest()).plugins).toEqual(["test-control-plane"]);
  await installPlugins([f.cp], { pluginHome: f.home, target: "control-plane", runtimeSpecifier: f.runtime });
  expect((await manifest()).plugins).toEqual(["test-control-plane"]);
  await installerCommand(["control-plane", "remove-plugin", "test-control-plane"]);
  expect((await manifest()).plugins).toEqual([]);
  expect(Object.keys(JSON.parse(await readFile(path.join(f.home, "package.json"), "utf8")).dependencies)).toEqual(["@slop-lab/dim-control-plane"]);
});

it("rejects both wrong-target combinations before replacing a working runtime", async () => {
  const f = await fixture();
  await installPlugins([f.host], { pluginHome: f.home, restartController: false });
  const before = await readFile(path.join(f.home, "package.json"), "utf8");
  await expect(installPlugins([f.cp], { pluginHome: f.home, restartController: false })).rejects.toThrow(/install control-plane plugin/);
  expect(await readFile(path.join(f.home, "package.json"), "utf8")).toBe(before);
  const cpHome = path.join(f.root, "cp", "current");
  await expect(installPlugins([f.host], { pluginHome: cpHome, target: "control-plane", runtimeSpecifier: f.runtime })).rejects.toThrow(/not a control-plane plugin/);
  await expect(readFile(path.join(cpHome, "plugins.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects CP dependencies that bring in host runtime packages", async () => {
  const f = await fixture();
  const core = await f.pack("@slop-lab/dim-core", "export const host = true;");
  const plugin = await f.pack("test-invalid-control-plane", "export const controlPlanePlugin = { apiVersion:1, name:'bad', configure() {} };", { dependencies: { "@slop-lab/dim-core": `file:${core}` } });
  await expect(installPlugins([plugin], { pluginHome: f.home, target: "control-plane", runtimeSpecifier: f.runtime })).rejects.toThrow(/must not install host runtime/);
  await expect(readFile(path.join(f.home, "plugins.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps home selection independent and rejects unknown targets before installing", async () => {
  expect(defaultControlPlanePluginHome({ DIM_DATA_HOME: "/srv/dim", DIM_PLUGIN_HOME: "/host" })).toBe("/srv/dim/control-plane/runtime/current");
  expect(defaultPluginHome({ DIM_DATA_HOME: "/srv/dim", DIM_CONTROL_PLANE_PLUGIN_HOME: "/cp" })).toBe("/srv/dim/runtime/current");
  await expect(installerCommand(["install", "plugin", "--target", "invalid", "test@1.0.0"])).rejects.toThrow(/Unknown option/);
  await expect(installerCommand(["install", "plugin", "@slop-lab/dim-plugin-control-plane-native-git@0.10.0"])).rejects.toThrow(/install control-plane plugin/);
});

it("installs the selected local CP artifact closure through the facade without selecting host packages", async () => {
  const f = await fixture();
  vi.stubEnv("DIM_CONFIG_PATH", path.join(f.root, "missing-cli.json"));
  vi.stubEnv("DIM_CONTROL_PLANE_PLUGIN_HOME", f.home);
  const dependency = await f.pack("test-cp-library", "export const library = true;");
  const plugin = await f.pack("test-cp-service", "export const controlPlanePlugin = {apiVersion:1,name:'service',configure(){}};", { dependencies: { "test-cp-library": "0.10.0" } });
  await writeFile(path.join(f.root, "packages.json"), JSON.stringify({ schemaVersion: 1, packages: [
    { name: "@slop-lab/dim-control-plane", version: "0.10.0", file: path.basename(f.runtime), requires: {} },
    { name: "test-cp-service", version: "0.10.0", file: path.basename(plugin), requires: { "test-cp-library": "0.10.0" } },
    { name: "test-cp-library", version: "0.10.0", file: path.basename(dependency), requires: {} },
    // An unselected host package must not be installed or even required on disk.
    { name: "@slop-lab/dim-cli", version: "0.10.0", file: "absent-cli.tgz", requires: {} }
  ] }));
  await installerCommand(["install", "control-plane", "plugin", "--local-packages", f.root, "test-cp-service@0.10.0"]);
  expect(JSON.parse(await readFile(path.join(f.home, "plugins.json"), "utf8"))).toEqual({ schemaVersion: 1, plugins: ["test-cp-service"] });
  expect(Object.keys(JSON.parse(await readFile(path.join(f.home, "package.json"), "utf8")).dependencies).sort()).toEqual([
    "@slop-lab/dim-control-plane", "test-cp-library", "test-cp-service"
  ]);
  expect((await exec(path.join(f.home, "node_modules/.bin/dim-control-plane"))).stdout.trim()).toBe("control-plane fixture");
  await expect(installerCommand(["install", "control-plane", "plugin", "--local-packages", f.root, "test-cp-service@0.11.0"])).rejects.toThrow(/does not match/);
});
