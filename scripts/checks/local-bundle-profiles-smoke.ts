#!/usr/bin/env node
import { object, array, string, parseJson } from "./lib/json-values.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 3 || !process.argv[2]) throw new Error("usage: node local-bundle-profiles-smoke.ts BUNDLE_DIRECTORY");
const bundle = path.resolve(process.argv[2]);
const manifest = object(parseJson(readFileSync(path.join(bundle, "packages.json"), "utf8")));
const packages = array(manifest.packages).map((value) => {
  const entry = object(value);
  return { name: string(entry.name), file: string(entry.file), version: string(entry.version) };
});

const artifact = (name: string) => {
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

function run(file: string, args: string[], allowFailure: boolean = false) {
  const result = spawnSync(file, args, { env, encoding: "utf8", timeout: 120_000 });
  if (!allowFailure) assert.equal(result.status, 0, `${file} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result;
}
try {
  run("npm", ["install", "--prefix", path.join(scratch, "facade"), "--no-save", "--no-audit", "--no-fund",
    artifact("@slop-lab/dim-installer")]);
  const controlPlanePlugins = ["@slop-lab/dim-control-plane-plugin-git-repositories",
    "@slop-lab/dim-control-plane-plugin-code-review", "@slop-lab/dim-control-plane-plugin-merge-policy",
    "@slop-lab/dim-control-plane-plugin-git-ci", "@slop-lab/dim-control-plane-plugin-webhooks",
    "@slop-lab/dim-control-plane-plugin-ci-workflows", "@slop-lab/dim-control-plane-plugin-llm-router", "@slop-lab/dim-control-plane-plugin-ci"];
  run(facade, ["installer", "install", "control-plane", "plugin", "--local-packages", bundle,
    ...controlPlanePlugins.map((name) => `${name}@${packages.find((entry) => entry.name === name)?.version}`)]);
  assert.equal(existsSync(runtime), false, "control-plane plugins must not install a host runtime");
  assert.deepEqual(object(parseJson(readFileSync(path.join(controlPlaneRuntime, "plugins.json"), "utf8"))).plugins,
    [...controlPlanePlugins].sort());
  for (const name of ["@slop-lab/dim-host-core", "@slop-lab/dim-cli", "@slop-lab/dim-control-plane-admin", "@slop-lab/dim-host-plugin-native-git", "@slop-lab/dim-host-plugin-ci-worker"]) {
    assert.equal(existsSync(path.join(controlPlaneRuntime, "node_modules", name)), false);
  }
  run(process.execPath, ["--input-type=module", "--eval", `
    import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url';
    const require = createRequire(${JSON.stringify(path.join(controlPlaneRuntime, "package.json"))});
    const load = async name => import(pathToFileURL(require.resolve(name)).href);
    const {startControlPlanePlugins} = await load('@slop-lab/dim-control-plane-core');
    const {controlPlanePlugin} = await load('@slop-lab/dim-control-plane-plugin-ci-workflows');
    const prepared = await controlPlanePlugin.configure({});
    const {requireWorkflowCompiler} = await load('@slop-lab/dim-contracts-ci/workflow');
    const jobs = requireWorkflowCompiler(prepared.extensions).compile(Buffer.from('jobs:\\n  source: {script: check.bash}\\n'));
    if (jobs[0]?.name !== 'source') throw new Error('installed workflow compiler did not compile');
    const running = await startControlPlanePlugins([{plugin:controlPlanePlugin,config:{}}],new AbortController().signal);
    await running.close();
  `]);
  console.log("control-plane artifacts: native Git, workflows and router install without host core, CLI or admin");
  const install = ["installer", "install", "core", "--local-packages", bundle, "--no-local-bin"];
  run(facade, install);
  assert.deepEqual(Object.keys(dependencies()).sort(), ["@slop-lab/dim-cli", "@slop-lab/dim-host-core"]);
  assert.equal(existsSync(path.join(runtime, "node_modules/@slop-lab/dim-control-plane-admin")), false);
  assert.deepEqual(JSON.parse(run(facade, ["ls", "--json"]).stdout), []);
  const absent = run(facade, ["control-plane", "--help"], true);
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /install core --with-managed/);
  console.log("base artifacts: installed CLI/core only, no managed service or backend configuration required");

  run(facade, [...install, "--with-managed"]);
  const profilePlugins = ["@slop-lab/dim-host-plugin-native-git", "@slop-lab/dim-host-plugin-ci-worker"];
  assert.deepEqual(plugins().sort(), [...profilePlugins].sort());
  for (const name of ["@slop-lab/dim-cli", "@slop-lab/dim-host-core", "@slop-lab/dim-control-plane-admin", ...profilePlugins]) {
    assert.ok(existsSync(path.join(runtime, "node_modules", name)), `profile is missing ${name}`);
  }
  run(facade, ["control-plane", "--help"]);
  for (const name of Object.keys(dependencies())) {
    const entry = packages.find((entry) => entry.name === name);
    assert.ok(entry, `missing ${name}`);
    const expected = entry.version;
    assert.equal(object(parseJson(readFileSync(path.join(runtime, "node_modules", name, "package.json"), "utf8"))).version, expected);
  }
  console.log("host profile: explicit native Git and CI worker plugins with operator tools");

  const selectedHostPlugins = ["@slop-lab/dim-host-plugin-mirrors", "@slop-lab/dim-host-plugin-cache-server", "@slop-lab/dim-host-plugin-external-urls"];
  run(facade, ["installer", "install", "plugin", "--local-packages", bundle,
    ...selectedHostPlugins.map((name) => `${name}@${packages.find((entry) => entry.name === name)?.version}`)]);
  assert.ok(existsSync(path.join(runtime, "node_modules/@slop-lab/dim-contracts-external-url")), "host plugin bundle must install its contracts dependency");
  run(facade, install);
  assert.deepEqual(plugins().sort(), [...profilePlugins, ...selectedHostPlugins].sort());
  assert.equal(path.resolve(runtime, string(dependencies()["@slop-lab/dim-host-plugin-mirrors"]).slice(5)),
    artifact("@slop-lab/dim-host-plugin-mirrors"));
  assert.equal(path.resolve(runtime, string(dependencies()["@slop-lab/dim-host-plugin-cache-server"]).slice(5)),
    artifact("@slop-lab/dim-host-plugin-cache-server"));
  assert.equal(existsSync(path.join(scratch, "state/dim", "services/package-caches.json")), false);
  assert.equal(existsSync(path.join(scratch, "config", "systemd/user/dim-controller.service")), false);
  assert.equal(existsSync(path.join(scratch, "run", "dim/controller.pid")), false);
  console.log("explicit plugin survives matched-bundle upgrade without controller activation");

  // Compile an independent plugin against the actual installed public SDK, not repository aliases.
  const fixture = path.join(scratch, "future-adapter"), output = path.join(fixture, "dist");
  mkdirSync(fixture);
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  const source = path.join(repository, "tests/scenarios/fixtures/mirror-adapter");
  for (const file of ["futureMirrorAdapter.ts", "futureMirrorGuestClient.ts"]) copyFileSync(path.join(source, file), path.join(fixture, file));
  const version = packages.find(({ name }) => name === "@slop-lab/dim-host-plugin-mirrors")?.version;
  assert.ok(version, "mirror package version must exist");
  const fixtureMetadata = { name: "@this-project/mirror-future-fixture", private: true, version, type: "module", exports: "./futureMirrorAdapter.js",
    peerDependencies: { "@slop-lab/dim-host-core": version, "@slop-lab/dim-host-plugin-mirrors": version } };
  writeFileSync(path.join(fixture, "package.json"), JSON.stringify(fixtureMetadata));
  symlinkSync(path.join(runtime, "node_modules"), path.join(fixture, "node_modules"), "dir");
  const compiler = path.join(repository, "tests/node_modules/typescript/bin/tsc");
  writeFileSync(path.join(fixture, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: true,
    typeRoots: [path.join(repository, "tests/node_modules/@types")], types: ["node"], outDir: "dist"
  }, include: ["*.ts"] }));
  run(process.execPath, [compiler, "-p", path.join(fixture, "tsconfig.json")]);
  writeFileSync(path.join(output, "package.json"), JSON.stringify(fixtureMetadata));
  const packed = array(parseJson(run("npm", ["pack", output, "--pack-destination", fixture, "--json"]).stdout));
  assert.equal(packed.length, 1);
  const tarball = path.join(fixture, string(object(packed[0]).filename));
  run(facade, ["installer", "install", "plugin", tarball]);
  const catalog = path.join(scratch, "future-cache.json");
  writeFileSync(catalog, JSON.stringify({ schemaVersion: 1, endpoints: { future: "https://future.example/cache/" } }));
  run(facade, ["mirrors", "configure", catalog]);
  assert.match(run(facade, ["mirrors", "ensure"]).stdout, /Cache connections configured: future/);
  const discovered = array(parseJson(run(facade, ["plugins"]).stdout));
  assert.ok(discovered.some((entry) => object(entry).name === "future-mirror-adapter"));
  assert.ok(plugins().includes("@this-project/mirror-future-fixture"));
  assert.equal(existsSync(path.join(scratch, "state/dim", "services/package-caches.json")), false);
  console.log("public mirror SDK: independently compiled and packed adapter installs, configures and resolves through enabled host plugins");

} finally { rmSync(scratch, { recursive: true, force: true }); }
