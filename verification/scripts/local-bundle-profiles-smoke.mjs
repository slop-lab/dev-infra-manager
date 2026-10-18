#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.argv.length !== 3) throw new Error("usage: node local-bundle-profiles-smoke.mjs BUNDLE_DIRECTORY");
const bundle = path.resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(path.join(bundle, "packages.json"), "utf8"));
const artifact = (name) => {
  const entry = manifest.packages.find((entry) => entry.name === name);
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
const runtime = path.join(env.DIM_DATA_HOME, "runtime/current");
const dependencies = () => JSON.parse(readFileSync(path.join(runtime, "package.json"), "utf8")).dependencies;
const plugins = () => JSON.parse(readFileSync(path.join(runtime, "plugins.json"), "utf8")).plugins;
function run(file, args, allowFailure = false) {
  const result = spawnSync(file, args, { env, encoding: "utf8", timeout: 120_000 });
  if (!allowFailure) assert.equal(result.status, 0, `${file} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result;
}
try {
  run("npm", ["install", "--prefix", path.join(scratch, "facade"), "--no-save", "--no-audit", "--no-fund",
    artifact("@slop-lab/dim-installer")]);
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
    "@slop-lab/dim-managed", "@slop-lab/dim-native-git", "@slop-lab/dim-plugin-ci-workflows"]);
  assert.deepEqual(plugins(), []);
  run(facade, ["managed", "--help"]);
  for (const name of Object.keys(dependencies())) {
    const expected = manifest.packages.find((entry) => entry.name === name).version;
    assert.equal(JSON.parse(readFileSync(path.join(runtime, "node_modules", name, "package.json"), "utf8")).version, expected);
  }
  console.log("managed artifacts: exact optional dependency closure, no automatic plugin activation");

  run(facade, ["installer", "install", "plugin", artifact("@slop-lab/dim-plugin-host-mirrors")]);
  run(facade, install);
  assert.deepEqual(plugins(), ["@slop-lab/dim-plugin-host-mirrors"]);
  assert.equal(path.resolve(runtime, dependencies()["@slop-lab/dim-plugin-host-mirrors"].slice(5)),
    artifact("@slop-lab/dim-plugin-host-mirrors"));
  assert.equal(existsSync(path.join(env.XDG_CONFIG_HOME, "systemd/user/dim-controller.service")), false);
  assert.equal(existsSync(path.join(env.XDG_RUNTIME_DIR, "dim/controller.pid")), false);
  console.log("explicit plugin survives matched-bundle upgrade without controller activation");
} finally { rmSync(scratch, { recursive: true, force: true }); }
