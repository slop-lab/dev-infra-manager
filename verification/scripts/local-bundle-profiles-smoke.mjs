#!/usr/bin/env node
// @ts-check
import { object, array, string, parseJson } from "./lib/json-values.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.argv.length !== 3 || !process.argv[2]) throw new Error("usage: node local-bundle-profiles-smoke.mjs BUNDLE_DIRECTORY");
const bundle = path.resolve(process.argv[2]);
const manifest = object(parseJson(readFileSync(path.join(bundle, "packages.json"), "utf8")));
const packages = array(manifest.packages).map((value) => {
  const entry = object(value);
  return { name: string(entry.name), file: string(entry.file), version: string(entry.version) };
});
/** @param {string} name */
const artifact = (name) => {
  const entry = packages.find((entry) => entry.name === name);
  if (!entry) throw new Error(`bundle has no ${name}`);
  return path.join(bundle, entry.file);
};
const scratch = mkdtempSync(path.join(tmpdir(), "dim-bundle-profiles-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DIM_")));
Object.assign(env, {
  HOME: path.join(scratch, "home"), XDG_CONFIG_HOME: path.join(scratch, "config"),
  XDG_DATA_HOME: path.join(scratch, "data"), XDG_STATE_HOME: path.join(scratch, "state"),
  XDG_RUNTIME_DIR: path.join(scratch, "run"), DIM_STATE_ROOT: path.join(scratch, "state/dim"),
  DIM_CONFIG_PATH: path.join(scratch, "config/dim.json"), DIM_DATA_HOME: path.join(scratch, "data/dim"),
  DIM_INSTALL_PREFIX: path.join(scratch, "prefix"), npm_config_cache: path.join(scratch, "npm-cache"),
  npm_config_userconfig: "/dev/null", npm_config_ignore_scripts: "true"
});
const facade = path.join(scratch, "facade/node_modules/.bin/dim");
const runtime = path.join(scratch, "data/dim/runtime/current");
const controlPlaneRuntime = path.join(scratch, "data/dim/control-plane/runtime/current");
const dependencies = () => object(object(parseJson(readFileSync(path.join(runtime, "package.json"), "utf8"))).dependencies);
const plugins = () => {
  const selected = object(parseJson(readFileSync(path.join(runtime, "plugins.json"), "utf8"))).plugins;
  assert.ok(Array.isArray(selected), "plugin manifest must contain an array");
  return selected.map(string);
};
/** @param {string} file @param {string[]} args @param {boolean} [allowFailure] */
function run(file, args, allowFailure = false) {
  const result = spawnSync(file, args, { env, encoding: "utf8", timeout: 120_000 });
  if (!allowFailure) assert.equal(result.status, 0, `${file} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result;
}
try {
  run("npm", ["install", "--prefix", path.join(scratch, "facade"), "--no-save", "--no-audit", "--no-fund",
    artifact("@slop-lab/dim-installer")]);
  const controlPlanePlugins = ["@slop-lab/dim-plugin-control-plane-native-git",
    "@slop-lab/dim-plugin-control-plane-ci-workflows", "@slop-lab/dim-plugin-control-plane-llm-router"];
  run(facade, ["installer", "install", "control-plane", "plugin", "--local-packages", bundle,
    ...controlPlanePlugins.map((name) => `${name}@${packages.find((entry) => entry.name === name)?.version}`)]);
  assert.equal(existsSync(runtime), false, "control-plane plugins must not install a host runtime");
  assert.deepEqual(object(parseJson(readFileSync(path.join(controlPlaneRuntime, "plugins.json"), "utf8"))).plugins,
    [...controlPlanePlugins].sort());
  for (const name of ["@slop-lab/dim-core", "@slop-lab/dim-cli", "@slop-lab/dim-managed"]) {
    assert.equal(existsSync(path.join(controlPlaneRuntime, "node_modules", name)), false);
  }
  run(process.execPath, ["--input-type=module", "--eval", `
    import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url';
    const require = createRequire(${JSON.stringify(path.join(controlPlaneRuntime, "package.json"))});
    const load = async name => import(pathToFileURL(require.resolve(name)).href);
    const {startControlPlanePlugins} = await load('@slop-lab/dim-control-plane');
    const {controlPlanePlugin} = await load('@slop-lab/dim-plugin-control-plane-ci-workflows');
    const prepared = await controlPlanePlugin.configure({});
    const jobs = prepared.workflowCompiler.compile(Buffer.from('jobs:\\n  source: {script: check.bash}\\n'));
    if (jobs[0]?.name !== 'source') throw new Error('installed workflow compiler did not compile');
    const running = await startControlPlanePlugins([{plugin:controlPlanePlugin,config:{}}],new AbortController().signal);
    await running.close();
  `]);
  console.log("control-plane artifacts: native Git, workflows and router install without core, CLI or managed");
  const install = ["installer", "install", "core", "--local-packages", bundle, "--no-local-bin"];
  run(facade, install);
  assert.deepEqual(Object.keys(dependencies()).sort(), ["@slop-lab/dim-cli", "@slop-lab/dim-core"]);
  assert.equal(existsSync(path.join(runtime, "node_modules/@slop-lab/dim-managed")), false);
  assert.deepEqual(JSON.parse(run(facade, ["ls", "--json"]).stdout), []);
  const absent = run(facade, ["managed", "--help"], true);
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /install core --with-managed/);
  console.log("base artifacts: installed CLI/core only, no managed service or backend configuration required");

  run(facade, [...install, "--with-managed"]);
  assert.deepEqual(Object.keys(dependencies()).sort(), ["@slop-lab/dim-cli", "@slop-lab/dim-core",
    "@slop-lab/dim-control-plane", "@slop-lab/dim-managed",
    "@slop-lab/dim-plugin-control-plane-ci-workflows", "@slop-lab/dim-plugin-control-plane-native-git"].sort());
  assert.deepEqual(plugins(), []);
  run(facade, ["managed", "--help"]);
  for (const name of Object.keys(dependencies())) {
    const entry = packages.find((entry) => entry.name === name);
    assert.ok(entry, `missing ${name}`);
    const expected = entry.version;
    assert.equal(object(parseJson(readFileSync(path.join(runtime, "node_modules", name, "package.json"), "utf8"))).version, expected);
  }
  console.log("managed artifacts: exact optional dependency closure, no automatic plugin activation");

  run(facade, ["installer", "install", "plugin", artifact("@slop-lab/dim-plugin-host-mirrors"), artifact("@slop-lab/dim-plugin-cache-server")]);
  run(facade, install);
  assert.deepEqual(plugins().sort(), ["@slop-lab/dim-plugin-cache-server", "@slop-lab/dim-plugin-host-mirrors"]);
  assert.equal(path.resolve(runtime, string(dependencies()["@slop-lab/dim-plugin-host-mirrors"]).slice(5)),
    artifact("@slop-lab/dim-plugin-host-mirrors"));
  assert.equal(path.resolve(runtime, string(dependencies()["@slop-lab/dim-plugin-cache-server"]).slice(5)),
    artifact("@slop-lab/dim-plugin-cache-server"));
  assert.equal(existsSync(path.join(scratch, "state/dim", "services/package-caches.json")), false);
  assert.equal(existsSync(path.join(scratch, "config", "systemd/user/dim-controller.service")), false);
  assert.equal(existsSync(path.join(scratch, "run", "dim/controller.pid")), false);
  console.log("explicit plugin survives matched-bundle upgrade without controller activation");
} finally { rmSync(scratch, { recursive: true, force: true }); }
