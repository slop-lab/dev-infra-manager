import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const assets = new Map(await Promise.all(["workspace-hosts.js", "workspace-create.js", "workspace-row.js", "workspace-ui.js", "feature-panels.js", "feature-ui.js", "session-data.js"].map(async (name) => [name, await readFile(new URL(`../../packages/web/core/src/assets/${name}`, import.meta.url))] as const)));
const firstId = "17094660-a627-4a17-acd2-6418c0b79967", secondId = "27094660-a627-4a17-acd2-6418c0b79967";
let id = firstId, phase = "running";
const calls: Array<{ name: string; input: unknown; csrf: string | undefined }> = [];
const feature = { id: "inline", title: "Inline tools", description: "Workspace contribution", surfaces: ["workspace"], configured: true, status: "ready", browserEntry: "/plugin.js", operations: [{ name: "start", description: "Start server", access: "operator" }] };
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/") {
    response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><div id="feature-navigation"><button id="feature-workspaces"></button><div id="feature-tabs"></div></div><div id="feature-panels"></div><div id="operations-panel"><div id="hosts"></div></div>'); return;
  }
  const asset = assets.get(request.url?.slice(1) ?? "");
  if (asset) { response.setHeader("Content-Type", "text/javascript"); response.end(asset); return; }
  if (request.url === "/plugin.js") {
    response.setHeader("Content-Type", "text/javascript"); response.end(`export function mount(container, context) {
      globalThis.contexts ??= []; globalThis.contexts.push(context);
      const status=document.createElement('p'), button=document.createElement('button');
      status.textContent=context.workspace.id+' '+context.workspace.phase; button.textContent='Start scoped server';
      button.onclick=async()=>{try {await context.invoke('start',context.workspace); if(context.isCurrent())status.textContent='started';}catch{}};
      container.append(status,button); return ()=>{globalThis.disposals=(globalThis.disposals??0)+1;};
    }`); return;
  }
  if (request.url === "/v1/extensions") { response.end(JSON.stringify([feature])); return; }
  if (request.url === "/v1/operations/hosts/local/workspaces") { response.end(JSON.stringify([{ name: "development", id, phase, runtime: "container", runtimeStatus: phase }])); return; }
  if (request.url === "/v1/extensions/inline/operations/start") {
    const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => chunks.push(chunk)); request.on("end", () => {
      calls.push({ name: "start", input: JSON.parse(Buffer.concat(chunks).toString()), csrf: request.headers["x-dim-csrf"] as string | undefined }); response.end("{}");
    }); return;
  }
  response.statusCode = 404; response.end("{}");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
const browser = await chromium.launch({ executablePath, headless: true }), page = await browser.newPage(), errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.addScriptTag({ type: "module", content: `
    import {createWorkspaceHosts} from '/workspace-hosts.js'; import {showFeaturePlugins,clearFeaturePlugins} from '/feature-panels.js';
    const hosts=createWorkspaceHosts(document.querySelector('#hosts'), async path=>(await fetch(path)).json());
    globalThis.fixture={hosts,clearFeaturePlugins};
    await hosts.refresh(['local'],true);
    await showFeaturePlugins({roles:['operator'],csrfToken:'fixture-csrf',capabilities:{operations:true}});
  ` });
  await page.locator(".workspace-row summary").getByText("Inline tools", { exact: true }).click();
   await page.getByText(`${firstId} running`, { exact: true }).waitFor();
   assert.equal(await page.evaluate("contexts[0].openFeature('not-installed')"), false);
   await page.locator('.workspace-feature').evaluate((details) => { if (details instanceof HTMLDetailsElement) details.open = false; });
   assert.equal(await page.evaluate("contexts[0].openFeature('inline')"), true);
   assert.equal(await page.locator('.workspace-feature').evaluate((details) => details instanceof HTMLDetailsElement && details.open), true);
  assert.equal(await page.locator("#feature-tabs button").count(), 0);
  assert.equal(await page.locator("#feature-navigation").isHidden(), true);
  await page.getByRole("button", { name: "Start scoped server" }).click();
  await page.getByText("started", { exact: true }).waitFor();
  assert.deepEqual(calls, [{ name: "start", input: { hostId: "local", name: "development", id: firstId, phase: "running" }, csrf: "fixture-csrf" }]);
  // A refresh retains the mount and its draft/state while identity and phase are unchanged.
  await page.evaluate("fixture.hosts.refresh(['local'],true)");
  assert.equal(await page.getByText("started", { exact: true }).count(), 1);
  // Same workspace name, different UUID: the old contribution loses invocation authority.
  id = secondId;
  await page.evaluate("fixture.hosts.refresh(['local'],true)");
  assert.equal(await page.evaluate("disposals"), 1);
   assert.equal(await page.evaluate("contexts[0].isCurrent()"), false);
   assert.equal(await page.evaluate("contexts[0].openFeature('inline')"), false);
  assert.equal(await page.evaluate("contexts[0].invoke('start',{}).then(()=>false,()=>true)"), true);
  assert.equal(calls.length, 1);
  await page.locator(".workspace-row summary").getByText("Inline tools", { exact: true }).click();
  await page.getByText(`${secondId} running`, { exact: true }).waitFor();
  phase = "stopped";
  await page.evaluate("fixture.hosts.refresh(['local'],true)");
  assert.equal(await page.evaluate("disposals"), 2);
  await page.locator(".workspace-row summary").getByText("Inline tools", { exact: true }).click();
  await page.getByText(`${secondId} stopped`, { exact: true }).waitFor();
  await page.evaluate("fixture.clearFeaturePlugins()");
  assert.equal(await page.evaluate("disposals"), 3);
  assert.equal(await page.evaluate("contexts[2].isCurrent()"), false);
  assert.equal(await page.getByRole("button", { name: "Start scoped server" }).count(), 0);
  assert.deepEqual(errors, []);
  process.stdout.write("Workspace plugin placement, exact UUID replacement, lifecycle disposal and session authorization passed.\n");
} finally { await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
