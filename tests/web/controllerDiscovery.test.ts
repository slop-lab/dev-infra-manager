import { scryptSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWebServerFromConfigFile } from "../../packages/web/core/src/server.js";
import { nativeGitManagementOperations } from "../../packages/service-clients/native-git/src/management.js";
import { webPluginContext } from "../../packages/web/core/src/controllers.js";
import { invokeWebPlugin, loadWebPlugins, reconnectWebPlugin, webPluginCatalog } from "../../packages/web/core/src/plugins.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-controller-discovery-")); roots.push(root);
  const calls = join(root, "calls.json"), state = join(root, "state.json"), executable = join(root, "dim");
  await writeFile(calls, "[]"); await writeFile(state, "true");
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2),path=${JSON.stringify(calls)},calls=JSON.parse(fs.readFileSync(path));calls.push(args);fs.writeFileSync(path,JSON.stringify(calls));if(!JSON.parse(fs.readFileSync(${JSON.stringify(state)}))){console.error('PRIVATE_SECRET /private/controller/path');process.exit(1);}if(args.includes('stdin')){let input='';for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify({args,input}));process.exit(0);}if(args.includes('slow'))await new Promise(resolve=>setTimeout(resolve,1000));if(args.includes('oversized'))console.log('x'.repeat(33*1024*1024));else console.log(JSON.stringify({args}));`, { mode: 0o700 });
  const directory = join(root, "node_modules/fixture-feature"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture-feature", type: "module", main: "index.js" }));
  await writeFile(join(directory, "index.js"), `const operation={name:'change',description:'Trusted fixture',access:'operator',parseInput(v){if(v && typeof v==='object'&&(Object.keys(v).length===0||Object.keys(v).length===1&&typeof v.manifest==='string'))return v;throw new Error('invalid');},parseOutput(v){return v;}};export const webPlugin={id:'fixture',title:'Fixture',description:'Controller discovery',operations:[operation],assets:{'panel.js':new URL('./panel.js',import.meta.url)},browserEntry:'panel.js',async create(config){if(config.reject)throw new Error("manual connection denied");return {invoke:async()=>({manual:config})};},async autoConnect(context){const controller=context.controllers[0];await controller.run(['fixture','discover']);return {invoke:(_name,input)=>controller.run(['fixture','change',...(input.manifest?[JSON.stringify(input)]:[])])};}};`);
  return { root, calls, state, context: webPluginContext([{ id: "remote-controller", selector: "selected-host", executable }]) };
}
it("discovers through fixed controllers, enforces operation roles and rediscovers on reconnect", async () => {
  const f = await fixture(), [plugin] = await loadWebPlugins([{ package: "fixture-feature" }], f.root, f.context);
  expect(webPluginCatalog([plugin!], ["read"])[0]).toMatchObject({ configured: true, status: "ready", operations: [] });
  await expect(invokeWebPlugin(plugin!, "change", {}, ["read"])).rejects.toMatchObject({ status: 403 });
  expect(JSON.parse(await readFile(f.calls, "utf8"))).toEqual([["--host", "selected-host", "fixture", "discover", "--json"]]);
  expect(await invokeWebPlugin(plugin!, "change", {}, ["operator"])).toEqual({ args: ["--host", "selected-host", "fixture", "change", "--json"] });
  await writeFile(f.state, "false"); await reconnectWebPlugin(plugin!);
  expect(webPluginCatalog([plugin!], ["operator"])[0]).toMatchObject({ configured: true, status: "unavailable", operations: [] });
  await expect(invokeWebPlugin(plugin!, "change", {}, ["operator"])).rejects.toMatchObject({ status: 409 });
  await writeFile(f.state, "true"); await reconnectWebPlugin(plugin!); expect(plugin!.status).toBe("ready");
  expect(JSON.parse(await readFile(f.calls, "utf8"))).toHaveLength(4);
});
it("gives explicit private config precedence and leaves discovery unconfigured without controllers", async () => {
  const f = await fixture(), [manual] = await loadWebPlugins([{ package: "fixture-feature", config: { selected: "private" } }], f.root, f.context);
  expect(await invokeWebPlugin(manual!, "change", {}, ["operator"])).toEqual({ manual: { selected: "private" } });
  await reconnectWebPlugin(manual!); expect(JSON.parse(await readFile(f.calls, "utf8"))).toEqual([]);
  const [denied] = await loadWebPlugins([{ package: "fixture-feature", config: { reject: true } }], f.root, f.context);
  expect(denied!.status).toBe("unavailable"); await reconnectWebPlugin(denied!);
  expect(JSON.parse(await readFile(f.calls, "utf8"))).toEqual([]);
  const [unconfigured] = await loadWebPlugins([{ package: "fixture-feature" }], f.root);
  expect(webPluginCatalog([unconfigured!], ["operator"])[0]).toMatchObject({ configured: false, status: "unconfigured" });
});
it("bounds argv/output, preserves literal values and rejects transport overrides before dispatch", async () => {
  const f = await fixture(), controller = f.context.controllers[0]!;
  for (const args of [[], ["--host", "foreign"], ["fixture", "--host=foreign"], ["fixture", "--json"], ["fixture", "bad\0argument"], ["fixture", "x".repeat(96 * 1024 + 1)], ["fixture", "한".repeat(32 * 1024 + 1)], Array.from({ length: 129 }, () => "x"), Array.from({ length: 3 }, () => "x".repeat(48 * 1024))]) await expect(controller.run(args)).rejects.toThrow("invalid controller command");
  for (const timeoutMilliseconds of [0, -1, 1.5, NaN, Infinity, 180001]) await expect(controller.run(["fixture"], { timeoutMilliseconds })).rejects.toThrow("invalid controller command timeout");
  const unexpected = { timeoutMilliseconds: 30, unexpected: true };
  await expect(controller.run(["fixture"], unexpected)).rejects.toThrow("invalid controller command timeout");
  expect(JSON.parse(await readFile(f.calls, "utf8"))).toEqual([]);
  await expect(controller.run(["slow"], { timeoutMilliseconds: 20 })).rejects.toThrow("unavailable");
  const literal = "repository; $(touch /tmp/not-executed)";
  expect(await controller.run(["fixture", literal])).toEqual({ args: ["--host", "selected-host", "fixture", literal, "--json"] });
  await expect(controller.run(["oversized"])).rejects.toThrow("invalid response");
  await writeFile(f.state, "false");
  const failure = await controller.run(["fixture"]).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toMatch(/PRIVATE_SECRET|\/private\/controller\/path/);
});
it("passes a realistic manifest through authenticated Web JSON and the actual controller executable without argument truncation", async () => {
  const f = await fixture(), origin = "http://127.0.0.1:9081", salt = Buffer.alloc(16, 7);
  const hash = scryptSync("browser-password", salt, 32, { N: 16384, r: 8, p: 1 });
  const config = join(f.root, "web.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port: 0, publicOrigin: origin,
    accounts: [{ username: "operator", passwordHash: `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`, roles: ["read", "operator"] }],
    pluginHome: f.root, plugins: [{ package: "fixture-feature" }], session: { idleSeconds: 900, absoluteSeconds: 3600 },
    operations: { hosts: [{ id: "controller", selector: "selected-host", executable: join(f.root, "dim") }] } }), { mode: 0o600 });
  const web = await createWebServerFromConfigFile(config);
  try {
    const base = await web.listen(), login = await fetch(base + "/v1/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: "operator", password: "browser-password" }) });
    expect(login.status).toBe(201);
    const session = await login.json() as { csrfToken: string };
    const headers = { origin, "content-type": "application/json", cookie: login.headers.get("set-cookie")!.split(";")[0]!, "x-dim-csrf": session.csrfToken };
    const manifest = "schemaVersion: 1\n" + "# repository policy explanation, kept literal\n".repeat(600);
    expect(Buffer.byteLength(manifest)).toBeGreaterThan(16 * 1024);
    const operation = nativeGitManagementOperations.find(({ name }) => name === "repositories.preview-manifest")!;
    expect(operation.parseInput({ projectId: "my-project", manifest })).toEqual({ projectId: "my-project", manifest });
    const response = await fetch(base + "/v1/extensions/fixture/operations/change", { method: "POST", headers, body: JSON.stringify({ manifest }) });
    expect(response.status).toBe(200);
    const output = await response.json() as { args: string[] };
    expect(output.args).toEqual(["--host", "selected-host", "fixture", "change", JSON.stringify({ manifest }), "--json"]);
    const calls = JSON.parse(await readFile(f.calls, "utf8")) as string[][];
    expect(calls.at(-1)).toEqual(output.args);
    const oversized = await fetch(base + "/v1/extensions/fixture/operations/change", { method: "POST", headers, body: JSON.stringify({ manifest: "x".repeat(128 * 1024) }) });
    expect(oversized.status).toBe(400);
    expect(JSON.parse(await readFile(f.calls, "utf8"))).toEqual(calls);
    expect(() => operation.parseInput({ projectId: "my-project", manifest: "한".repeat(22 * 1024) })).toThrow();
    expect(() => operation.parseInput({ projectId: "my-project", manifest: "\n".repeat(50 * 1024) })).toThrow();
  } finally { await web.close(); }
});

it("delivers bounded private input over stdin without placing it in argv", async () => {
  const f = await fixture(), controller = f.context.controllers[0]!;
  const input = JSON.stringify({ password: "quoted \" secret with spaces " });
  expect(await controller.run(["stdin"], { timeoutMilliseconds: 1000, input })).toEqual({ args: ["--host", "selected-host", "stdin", "--json"], input });
  expect(JSON.parse(await readFile(f.calls, "utf8"))).toEqual([["--host", "selected-host", "stdin", "--json"]]);
  await expect(controller.run(["stdin"], { timeoutMilliseconds: 1000, input: "한".repeat(44 * 1024) })).rejects.toThrow("invalid controller command input");
  expect(JSON.parse(await readFile(f.calls, "utf8"))).toHaveLength(1);
});

it("carries a multi-megabyte review and reports an oversized completed mutation as unknown, not rejected", async () => {
  const f = await fixture(), receipt = join(f.root, "mutation.json");
  await writeFile(join(f.root, "dim"), `#!${process.execPath}\n// @ts-check\nimport fs from 'node:fs';const args=process.argv.slice(2);if(args.includes('discover')){console.log('{}');}else{const input=JSON.parse(args.find(arg=>arg.startsWith('{'))??'{}');fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({completed:true,mode:input.manifest}));console.log(JSON.stringify({reviewId:'exact-review',patch:input.manifest==='overflow'?'x'.repeat(33*1024*1024):'+line\\n'.repeat(500000)}));}`, { mode: 0o700 });
  const [plugin] = await loadWebPlugins([{ package: "fixture-feature" }], f.root, f.context);
  const review = await invokeWebPlugin(plugin!, "change", { manifest: "review" }, ["operator"]) as { reviewId: string; patch: string };
  expect(review.reviewId).toBe("exact-review");
  expect(review.patch).toBe("+line\n".repeat(500000));
  expect(Buffer.byteLength(JSON.stringify(review))).toBeGreaterThan(2 * 1024 * 1024);
  expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({ completed: true, mode: "review" });
  await expect(invokeWebPlugin(plugin!, "change", { manifest: "overflow" }, ["operator"])).rejects.toMatchObject({
    status: 502, code: "host_result_unavailable", publicMessage: expect.stringContaining("It may have completed")
  });
  expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({ completed: true, mode: "overflow" });
});
