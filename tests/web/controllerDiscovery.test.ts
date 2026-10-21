import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { webPluginContext } from "../../packages/web/core/src/controllers.js";
import { invokeWebPlugin, loadWebPlugins, reconnectWebPlugin, webPluginCatalog } from "../../packages/web/core/src/plugins.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-controller-discovery-")); roots.push(root);
  const calls = join(root, "calls.json"), state = join(root, "state.json"), executable = join(root, "dim");
  await writeFile(calls, "[]"); await writeFile(state, "true");
  await writeFile(executable, `#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2),path=${JSON.stringify(calls)},calls=JSON.parse(fs.readFileSync(path));calls.push(args);fs.writeFileSync(path,JSON.stringify(calls));if(!JSON.parse(fs.readFileSync(${JSON.stringify(state)})))process.exit(1);if(args.includes('slow'))await new Promise(resolve=>setTimeout(resolve,1000));if(args.includes('oversized'))console.log('x'.repeat(3*1024*1024));else console.log(JSON.stringify({args}));`, { mode: 0o700 });
  const directory = join(root, "node_modules/fixture-feature"); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture-feature", type: "module", main: "index.js" }));
  await writeFile(join(directory, "index.js"), `const operation={name:'change',description:'Trusted fixture',access:'operator',parseInput(v){if(v && typeof v==='object'&&Object.keys(v).length===0)return v;throw new Error('invalid');},parseOutput(v){return v;}};export const webPlugin={id:'fixture',title:'Fixture',description:'Controller discovery',operations:[operation],assets:{'panel.js':new URL('./panel.js',import.meta.url)},browserEntry:'panel.js',async create(config){if(config.reject)throw new Error("manual connection denied");return {invoke:async()=>({manual:config})};},async autoConnect(context){const controller=context.controllers[0];await controller.run(['fixture','discover']);return {invoke:()=>controller.run(['fixture','change'])};}};`);
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
  for (const args of [[], ["--host", "foreign"], ["fixture", "--host=foreign"], ["fixture", "--json"], ["fixture", "bad\0argument"], ["fixture", "x".repeat(4097)], Array.from({ length: 129 }, () => "x"), Array.from({ length: 20 }, () => "x".repeat(2000))]) await expect(controller.run(args)).rejects.toThrow("invalid controller command");
  for (const timeoutMilliseconds of [0, -1, 1.5, NaN, Infinity, 180001]) await expect(controller.run(["fixture"], { timeoutMilliseconds })).rejects.toThrow("invalid controller command timeout");
  const unexpected = { timeoutMilliseconds: 30, unexpected: true };
  await expect(controller.run(["fixture"], unexpected)).rejects.toThrow("invalid controller command timeout");
  expect(JSON.parse(await readFile(f.calls, "utf8"))).toEqual([]);
  await expect(controller.run(["slow"], { timeoutMilliseconds: 20 })).rejects.toThrow("unavailable");
  const literal = "repository; $(touch /tmp/not-executed)";
  expect(await controller.run(["fixture", literal])).toEqual({ args: ["--host", "selected-host", "fixture", literal, "--json"] });
  await expect(controller.run(["oversized"])).rejects.toThrow("invalid response");
});
