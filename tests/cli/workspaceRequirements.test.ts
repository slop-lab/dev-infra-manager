import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProcessRunner, WorkspaceService, WorkspaceStore, acquireWorkspaceSource, type WorkspaceRuntime, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import { exactPluginSpec, installRequiredPlugins, missingPlugins, workspaceRequirements } from "../../packages/cli/src/workspace-requirements.js";
import { createWorkspaceWithPlugins } from "../../packages/cli/src/workspace-create-client.js";
import { encodeHostRequest, type HostRequest } from "../../packages/cli/src/host-transport.js";
import { HostContextStore } from "../../packages/cli/src/host-context.js";

const spec = "@slop-lab/dim-host-plugin-mirrors@0.10.0";
const commit = "a".repeat(40), target = { name: "remote", ssh: "dev@example.invalid" };
const required = { status: "requires-plugins", source: { url: "/srv/repo", ref: "refs/heads/main", commit }, plugins: [spec] };
const record: WorkspaceRecord = { schemaVersion: 10, id: "00000000-0000-4000-8000-000000000001", name: "dev", source: required.source,
  runtime: "container", image: "image", resources: { cpuCount: "2", memory: "4g", pidsLimit: "2048" }, git: { name: "Dev", email: "dev@example.invalid" }, initialized: true, phase: "running", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

test("declarations admit general exact registry packages and reject executable/path/range input", () => {
  for (const name of [spec, "example-plugin@1.2.3", "@team/plugin@1.0.0-rc.1+build"]) assert.equal(exactPluginSpec(name).spec, name);
  for (const value of ["file:/tmp/plugin.tgz", "https://example.invalid/plugin.tgz", "@team/plugin@^1.2.3", "@team/plugin@latest", "../plugin@1.0.0", "plugin@1.2.3;touch /tmp/bad"]) assert.throws(() => exactPluginSpec(value));
});

test("actual Git checkout requirements fail before records/runtime; source movement after approval is rejected", async () => {
  await fixture(async (root) => {
    const home = path.join(root, "plugins"), source = path.join(root, "repo");
    const previous = process.env.DIM_PLUGIN_HOME; process.env.DIM_PLUGIN_HOME = home;
    try {
      await mkdir(path.join(source, ".dim"), { recursive: true });
      await writeFile(path.join(source, ".dim/workspace.json"), JSON.stringify({ plugins: [spec] }));
      const runner = new ProcessRunner();
      const git = async (...args: string[]) => { const result = await runner.run("git", ["-C", source, ...args]); assert.equal(result.exitCode, 0, result.stderr); return result.stdout.trim(); };
      await git("init", "--initial-branch=main"); await git("add", ".");
      await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "requirements");
      let runtimeCalls = 0;
      const unexpected = async (): Promise<never> => { runtimeCalls++; throw new Error("runtime must not run"); };
      const runtime: WorkspaceRuntime = { create: unexpected, start: unexpected, stop: unexpected, remove: unexpected, inspect: unexpected,
        seed: unexpected, exec: unexpected, connect: unexpected, updateResources: unexpected };
      const store = new WorkspaceStore(path.join(root, "state"));
      const check = workspaceRequirements();
      const service = new WorkspaceService(store, runtime, async (input) => {
        const acquired = await acquireWorkspaceSource(input); await check.validateCheckout(input.destination, acquired); return acquired;
      });
      await assert.rejects(service.create({ name: "dev", source: { url: source } }), /requires installed plugins/);
      assert.equal(check.missing?.source.commit, await git("rev-parse", "HEAD"));
      assert.deepEqual(check.missing?.plugins, [spec]); assert.equal(runtimeCalls, 0); assert.deepEqual(await store.list(), []);
      assert.deepEqual(await readdir(path.join(store.root, "staging")), []);
      const cli = fileURLToPath(new URL("../../packages/cli/src/cli.ts", import.meta.url));
      const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
      const response = await runner.run(process.execPath, ["--conditions=dim-source", tsx, cli, "__host", encodeHostRequest({ operation: "create", input: { name: "dev", source: { url: source } } })], {
        env: { ...process.env, DIM_PLUGIN_HOME: home, DIM_STATE_ROOT: store.root }
      });
      assert.equal(response.exitCode, 0, response.stderr);
      assert.deepEqual(JSON.parse(response.stdout), check.missing);
      assert.deepEqual(await store.list(), []);
      await installed(home, "0.10.0");
      await writeFile(path.join(source, "changed"), "new commit"); await git("add", ".");
      await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "changed during approval");
      const retry = workspaceRequirements(check.missing!.source.commit);
      const service2 = new WorkspaceService(store, runtime, async (input) => { const acquired = await acquireWorkspaceSource(input); await retry.validateCheckout(input.destination, acquired); return acquired; });
      await assert.rejects(service2.create({ name: "dev", source: { url: source } }), /source changed/);
      assert.equal(runtimeCalls, 0); assert.deepEqual(await store.list(), []);
    } finally { restore("DIM_PLUGIN_HOME", previous); }
  });
});

test("requirements check enabled exact installed metadata; obsolete versions and disabled packages are missing", async () => {
  await fixture(async (root) => {
    assert.deepEqual(await missingPlugins([spec], root), [spec]);
    await installed(root, "0.9.0"); assert.deepEqual(await missingPlugins([spec], root), [spec]);
    await installed(root, "0.10.0"); assert.deepEqual(await missingPlugins([spec], root), []);
    await writeFile(path.join(root, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: [] }));
    assert.deepEqual(await missingPlugins([spec], root), [spec]);
  });
});

test("workspace preflight ignores plugin YAML and project-owned scripts", async () => {
  await fixture(async (root) => {
    await mkdir(path.join(root, ".dim/ci"), { recursive: true });
    await mkdir(path.join(root, ".dim/review"));
    await writeFile(path.join(root, ".dim/workspace.json"), '{"plugins":[]}');
    for (const file of ["repos.yml", "ci/runner.yml"]) await writeFile(path.join(root, ".dim", file), "deliberately invalid: [ YAML");
    const marker = path.join(root, "executed");
    await writeFile(path.join(root, ".dim/review/matcher.mjs"), `// @ts-check\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`);
    const check = workspaceRequirements(); await check.validateCheckout(root, required.source);
    assert.equal(check.missing, undefined); await assert.rejects(readFile(marker), { code: "ENOENT" });
  });
});

test("checkout config refuses symlink traversal, oversized files, unknown keys, and duplicate package names", async () => {
  await fixture(async (root) => {
    const checkout = path.join(root, "checkout"); await mkdir(checkout);
    await symlink(root, path.join(checkout, ".dim"));
    await assert.rejects(workspaceRequirements().validateCheckout(checkout, required.source), /real checkout directory/);
    await rm(path.join(checkout, ".dim")); await mkdir(path.join(checkout, ".dim"));
    const file = path.join(checkout, ".dim/workspace.json"); await symlink(path.join(root, "secret"), file);
    await assert.rejects(workspaceRequirements().validateCheckout(checkout, required.source)); await rm(file);
    for (const content of [" ".repeat(32_769), JSON.stringify({ plugins: [], run: "host code" }), JSON.stringify({ plugins: [spec, spec] })]) {
      await writeFile(file, content); await assert.rejects(workspaceRequirements().validateCheckout(checkout, required.source));
    }
    await rm(file); await workspaceRequirements().validateCheckout(checkout, required.source);
  });
});

test("non-TTY missing requirements and declined approval never send installer requests", async () => {
  const requests: HostRequest[] = [];
  const request = async (_target: unknown, input: HostRequest) => { requests.push(input); return required; };
  await assert.rejects(createWorkspaceWithPlugins(target, {}, { request }), /remote.*needs plugins/);
  await assert.rejects(createWorkspaceWithPlugins(target, {}, { request, approve: async () => false }), /declined/);
  assert.deepEqual(requests.map(({ operation }) => operation), ["create", "create"]);
});

test("approved create installs on the same selected host then pins retry to inspected commit", async () => {
  const requests: HostRequest[] = [];
  const result = await createWorkspaceWithPlugins(target, { name: "dev", source: { url: "/srv/repo", ref: "main" } }, {
    approve: async (value, host) => { assert.deepEqual(value, required); assert.deepEqual(host, target); return true; },
    request: async (host, input) => { assert.deepEqual(host, target); requests.push(input); return requests.length === 1 ? required : requests.length === 2 ? { installed: true } : record; }
  });
  assert.deepEqual(result, record);
  assert.deepEqual(requests[1], { operation: "plugins.installRequired", input: { plugins: [spec] } });
  assert.deepEqual(requests[2]?.input, { name: "dev", source: { url: "/srv/repo", ref: "main" }, expectedSourceCommit: commit });
});

test("actual facade subprocess uses explicit argv, bounded diagnostics, private host installation and cancellation", async () => {
  await fixture(async (root) => {
    const previousHome = process.env.DIM_PLUGIN_HOME, previousFacade = process.env.DIM_INSTALLER_ENTRYPOINT;
    process.env.DIM_PLUGIN_HOME = root;
    const facade = path.join(root, "facade.mjs"); process.env.DIM_INSTALLER_ENTRYPOINT = facade;
    try {
      await writeFile(facade, `// @ts-check\nimport fs from 'node:fs/promises'; const root=process.env.DIM_PLUGIN_HOME; if(!root)throw Error('root'); await fs.writeFile(root+'/argv.json',JSON.stringify(process.argv.slice(2))); await fs.mkdir(root+'/node_modules/@slop-lab/dim-host-plugin-mirrors',{recursive:true}); await fs.writeFile(root+'/plugins.json',JSON.stringify({schemaVersion:1,plugins:['@slop-lab/dim-host-plugin-mirrors']})); await fs.writeFile(root+'/node_modules/@slop-lab/dim-host-plugin-mirrors/package.json',JSON.stringify({name:'@slop-lab/dim-host-plugin-mirrors',version:'0.10.0'}));`);
      await installRequiredPlugins([spec], new ProcessRunner(), AbortSignal.timeout(5000));
      assert.deepEqual(JSON.parse(await readFile(path.join(root, "argv.json"), "utf8")), ["installer", "install", "plugin", spec]);
      await writeFile(facade, "// @ts-check\nprocess.stderr.write('x'.repeat(20000)+' useful stage failure');process.exitCode=9;");
      await assert.rejects(installRequiredPlugins([spec], new ProcessRunner(), AbortSignal.timeout(5000)), (error: unknown) => error instanceof Error && error.message.length < 8400 && /useful stage failure/.test(error.message));
      await writeFile(facade, "// @ts-check\nsetInterval(()=>{},1000);");
      await assert.rejects(installRequiredPlugins([spec], new ProcessRunner(), AbortSignal.timeout(100)), /abort|timeout/i);
    } finally { restore("DIM_PLUGIN_HOME", previousHome); restore("DIM_INSTALLER_ENTRYPOINT", previousFacade); }
  });
});

test("real client TTY prompts before selected-SSH-host installation and retries the inspected commit", async () => {
  await fixture(async (root) => {
    const config = path.join(root, "config"), bin = path.join(root, "bin"); await mkdir(bin);
    await new HostContextStore(config).add(target);
    const ssh = path.join(bin, "ssh");
    await writeFile(ssh, `#!/usr/bin/env node\n// @ts-check\nimport fs from 'node:fs';
const root=process.env.DIM_TEST_REQUIRED_ROOT;if(!root)throw Error('root');
const encoded=/__host ([A-Za-z0-9_-]+)/.exec(process.argv.at(-1)||'')?.[1];if(!encoded)throw Error('host payload');
const request=JSON.parse(Buffer.from(encoded,'base64url').toString());fs.appendFileSync(root+'/requests',JSON.stringify(request)+'\\n');
if(request.operation==='plugins.installRequired'){fs.writeFileSync(root+'/installed','yes');console.log(JSON.stringify({installed:true}));}
else console.log(JSON.stringify(fs.existsSync(root+'/installed')?${JSON.stringify(record)}:${JSON.stringify(required)}));`, { mode: 0o700 });
    const cli = fileURLToPath(new URL("../../packages/cli/src/cli.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const command = [process.execPath, "--conditions=dim-source", tsx, cli, "--host", "remote", "create", "/srv/repo", "dev", "--json"].map(shellQuote).join(" ");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("script", ["--quiet", "--return", "--command", command, "/dev/null"], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: config, DIM_TEST_REQUIRED_ROOT: root },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let data = "", approved = false;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`TTY prompt timed out: ${data}`)); }, 10_000);
      const collect = (chunk: Buffer) => { data += chunk.toString(); if (!approved && data.includes("Approve plugin installation?")) { approved = true; child.stdin.write("yes\n"); } };
      child.stdout.on("data", collect); child.stderr.on("data", collect); child.once("error", reject);
      child.once("close", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(data)); else resolve(data); });
    });
    assert.match(output, /Install and enable host code on 'remote'/);
    assert.match(output, new RegExp(commit));
    const requests = (await readFile(path.join(root, "requests"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as HostRequest);
    assert.deepEqual(requests.map(({ operation }) => operation), ["create", "plugins.installRequired", "create"]);
    assert.equal(requests[2]?.input?.expectedSourceCommit, commit);
  });
});

async function installed(home: string, version: string) {
  const directory = path.join(home, "node_modules/@slop-lab/dim-host-plugin-mirrors"); await mkdir(directory, { recursive: true });
  await writeFile(path.join(home, "plugins.json"), JSON.stringify({ schemaVersion: 1, plugins: ["@slop-lab/dim-host-plugin-mirrors"] }));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "@slop-lab/dim-host-plugin-mirrors", version }));
}
function restore(key: string, value: string | undefined) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
async function fixture(action: (root: string) => Promise<void>) { const root = await mkdtemp(path.join(tmpdir(), "dim-required-plugins-")); try { await action(root); } finally { await rm(root, { recursive: true, force: true }); } }
function shellQuote(value: string) { return `'${value.replace(/'/g, `'"'"'`)}'`; }
