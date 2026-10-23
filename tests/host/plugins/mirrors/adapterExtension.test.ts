import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { atomicWrite } from "@slop-lab/dim-host-core";
import { loadHostPlugins, resolveHostExecutionRouting } from "../../../../packages/host/core/src/application/host-plugins.js";
import { hostPlugin } from "../../../../packages/host/plugins/mirrors/src/index.js";
import { WorkspaceStore } from "@slop-lab/dim-host-core/workspace";
import { workspaceRecord } from "../../../support/workspaceFixture.js";
import { mirrorAdapterExtension } from "../../../../packages/host/plugins/mirrors/src/protocol-plugin-api.js";
import { adapterModules, loadMirrorAdapters } from "../../../../packages/host/plugins/mirrors/src/registry.js";
import { mirrorRouting } from "../../../../packages/host/plugins/mirrors/src/cache-routing.js";
import { parseCacheCatalog } from "../../../../packages/host/plugins/mirrors/src/provider.js";
import { createMirrorRelay } from "../../../../packages/host/plugins/mirrors/src/relay.js";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });

it("loads a separately installed adapter and relays its artifacts without a Docker endpoint or core protocol edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-extra-mirror-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const module = join(root, "adapter.mjs"), client = join(root, "client.mjs");
  await writeFile(client, `// @ts-check\nexport function clientConfiguration(endpoint) { return {files:[{target:'/etc/future-cache.conf',contents:endpoint}],environmentDefaults:{FUTURE_CACHE_CONFIG:'/etc/future-cache.conf'}}; }\nexport async function configureSystem() {}\n`);
  // This module is outside mirrors and uses only its documented adapter shape.
  await writeFile(module, `// @ts-check
import {clientConfiguration} from './client.mjs';
export const mirrorAdapter = {
  kind:'future', description:'Future artifact cache', commands:[{name:'future',description:'Fetch future artifacts'}],
  guestModuleUrl:new URL('./client.mjs',import.meta.url).href, clientConfiguration,
  normalizeEndpoint(input) {
    const url=new URL(input);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw Error('invalid future endpoint');
    return url.href.endsWith('/')?url.href:url.href+'/';
  },
  target(path,endpoint) {
    if(!/^\\/artifacts\\/[a-z0-9.-]+$/.test(path)) return;
    const base=new URL(endpoint), target=new URL(path.slice(1),base);
    return target.origin===base.origin && target.pathname.startsWith(base.pathname)?target:undefined;
  },
  metadata: {
    accepts:type=>type.includes('application/json'),
    rewrite(contents,{endpoint,clientOrigin}) {
      const value=JSON.parse(contents), base=new URL(endpoint), target=new URL(value.download);
      if(target.origin!==base.origin||!target.pathname.startsWith(base.pathname)) throw Error('artifact escaped repository');
      return JSON.stringify({download:clientOrigin+'/'+target.href.slice(base.href.length)});
    }
  }
};`);
  const extensions = [mirrorAdapterExtension("future", pathToFileURL(module))], modules = adapterModules(extensions);
  const adapters = await loadMirrorAdapters(modules);
  expect(() => parseCacheCatalog({ schemaVersion: 1, endpoints: { future: "https://cache.example/" } })).toThrow(/install.*adapter/);
  const requests: string[] = [];
  const upstream = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/cache/artifacts/metadata") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ download: `${origin}/cache/artifacts/bundle` }));
    } else response.end(Buffer.from([0, 255, 128, 10]));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("upstream absent");
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoints = parseCacheCatalog({ schemaVersion: 1, endpoints: { future: `${origin}/cache/` } }, adapters);
  const home = join(root, "runtime"), packageRoot = join(home, "node_modules/future-mirror");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(home, "package.json"), '{"private":true}');
  await writeFile(join(packageRoot, "package.json"), '{"name":"future-mirror","type":"module","main":"index.mjs"}');
  await writeFile(join(packageRoot, "index.mjs"), `// @ts-check\nexport const hostPlugin = ${JSON.stringify({ name: "future-mirror", extensions })};\n`);
  await atomicWrite(join(home, "plugins.json"), { schemaVersion: 1, plugins: ["future-mirror"] });
  await atomicWrite(join(root, "plugins/host-mirrors/config.json"), { schemaVersion: 1, endpoints });
  vi.stubEnv("DIM_PLUGIN_HOME", home); vi.stubEnv("DIM_STATE_ROOT", root);
  const installed = await loadHostPlugins();
  const forbidden = async (): Promise<never> => { throw new Error("URL clients must not install servers"); };
  const runner = { run: forbidden, runStreaming: forbidden };
  const context = { runner, cleanupRunner: runner, stateRoot: root, signal: new AbortController().signal };
  const routing = await resolveHostExecutionRouting([hostPlugin, ...installed], context);
  expect(routing).toEqual(mirrorRouting(endpoints, adapters));
  await atomicWrite(join(home, "plugins.json"), { schemaVersion: 1, plugins: [] });
  await expect(resolveHostExecutionRouting([hostPlugin, ...await loadHostPlugins()], context)).rejects.toThrow(/unknown cache kind/);
  expect(routing).toMatchObject({ dockerDaemonConfig: "{}", blockedHostnames: [], jobFiles: [{ target: "/etc/future-cache.conf", contents: `${origin}/cache/` }], jobEnvironmentDefaults: { FUTURE_CACHE_CONFIG: "/etc/future-cache.conf" } });
  const store = new WorkspaceStore(join(root, "workspaces")), workspace = workspaceRecord(); await store.write(workspace);
  const token = "a".repeat(43), id = randomUUID();
  const relay = await createMirrorRelay({ workspaceStateRoot: store.root, workspaceName: workspace.name, workspaceId: workspace.id,
    listen: "127.0.0.1", endpoints, adapterModules: modules, controlToken: token, configurationId: id });
  cleanup.push(() => relay.close());
  expect(Object.keys(relay.ports)).toEqual(["future"]);
  const base = `http://127.0.0.1:${relay.ports.future}`;
  const metadata: unknown = await (await fetch(`${base}/artifacts/metadata`)).json();
  expect(metadata).toEqual({ download: `${base}/artifacts/bundle` });
  expect(Buffer.from(await (await fetch(`${base}/artifacts/bundle`)).arrayBuffer())).toEqual(Buffer.from([0, 255, 128, 10]));
  expect(requests).toEqual(["/cache/artifacts/metadata", "/cache/artifacts/bundle"]);
  expect((await fetch(`${base}/admin`)).status).toBe(403);
  const control = `http://127.0.0.1:${relay.controlPort}/__dim/health`;
  expect((await fetch(control)).status).toBe(403);
  expect(await (await fetch(control, { headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ workspaceId: workspace.id, configurationId: id });
  await expect(loadMirrorAdapters([modules[0]!, modules[0]!])).rejects.toThrow(/duplicate/);
});

it("configures only selected built-in clients and rejects conflicting adapter outputs", async () => {
  const endpoints = parseCacheCatalog({ schemaVersion: 1, endpoints: { npm: "https://npm.example/" } });
  const routing = mirrorRouting(endpoints);
  expect(routing.blockedHostnames).toEqual([]);
  expect(routing.dockerDaemonConfig).toBe("{}");
  expect(routing.jobFiles?.map(({ target }) => target)).toEqual(["/etc/npmrc"]);
  expect(() => parseCacheCatalog({ schemaVersion: 1, endpoints: {} })).toThrow(/between one/);
  const adapters = new Map(await loadMirrorAdapters());
  const npm = adapters.get("npm")!;
  adapters.set("duplicate", { ...npm, kind: "duplicate" });
  expect(() => mirrorRouting({ npm: "https://npm.example/", duplicate: "https://npm.example/" }, adapters)).toThrow(/conflicting.*file/);
});
