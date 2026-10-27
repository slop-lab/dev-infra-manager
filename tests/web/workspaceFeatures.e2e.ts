import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import type { WebNavigationResult } from "../../packages/web/core/src/plugin-api.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const assets = new Map(await Promise.all(["workspace-hosts.js", "workspace-create.js", "workspace-row.js", "workspace-ui.js", "workspace-features.js", "feature-transport.js", "console-location.js", "settings-panel.js", "account-access.js", "account-management.js", "feature-panels.js", "feature-ui.js", "navigation-broker.js", "session-data.js", "session-boundary.js", "tokens.css", "app.css"].map(async (name) => [name, await readFile(new URL(`../../packages/web/core/src/assets/${name}`, import.meta.url))] as const)));
const evidence = process.env.DIM_WEB_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
const firstId = "17094660-a627-4a17-acd2-6418c0b79967", secondId = "27094660-a627-4a17-acd2-6418c0b79967";
let id = firstId, phase = "running";
const calls: Array<{ name: string; input: unknown; csrf: string | undefined }> = [];
const feature = { id: "inline", title: "Inline tools", description: "Workspace contribution", surfaces: ["workspace"], configured: true, status: "ready", browserEntry: "/plugin.js", operations: [{ name: "start", description: "Start server", access: "operator" }] };
const destination = { id: "destination", title: "Destination", description: "Navigation destination", configured: true, status: "ready", browserEntry: "/destination.js", operations: [{ name: "read", description: "Read target", access: "read" }] };
const reconnect = { id: "reconnect", title: "Reconnect race", description: "Delayed browser entry", configured: true, status: "ready", browserEntry: "/reconnect.js", operations: [{ name: "read", description: "Read reconnect state", access: "read" }] };
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/") {
    response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"><nav id="feature-navigation" class="console-navigation"><a id="feature-workspaces" href="#/workspaces">Workspaces</a><div id="feature-tabs"></div></nav><div id="feature-panels"></div><section id="settings-panel" hidden></section><section id="route-unavailable" hidden></section><div id="operations-panel"><div id="hosts"></div></div>'); return;
  }
  const asset = assets.get(request.url?.slice(1) ?? "");
  if (asset) { response.setHeader("Content-Type", request.url?.endsWith(".css") ? "text/css" : "text/javascript"); response.end(asset); return; }
  if (request.url === "/plugin.js") {
    response.setHeader("Content-Type", "text/javascript"); response.end(`export function mount(container, context) {
      globalThis.contexts ??= []; globalThis.contexts.push(context);
      const status=document.createElement('p'), button=document.createElement('button');
      status.textContent=context.workspace.id+' '+context.workspace.phase; button.textContent='Start scoped server';
      const stopWorkspace=context.onWorkspaceChange?.(()=>{status.textContent=context.workspace.id+' '+context.workspace.phase;});
      const draft=document.createElement('input');draft.setAttribute('aria-label','Scoped draft');container.append(draft);
      button.onclick=async()=>{try {await context.invoke('start',context.workspace); if(context.isCurrent())status.textContent='started';}catch{}};
      container.append(status,button); return ()=>{stopWorkspace?.();globalThis.disposals=(globalThis.disposals??0)+1;};
    }`); return;
  }
  if (request.url === "/destination.js") {
    response.setHeader("Content-Type", "text/javascript"); response.end(`export async function mount(container, context) {
      globalThis.destinationMounts=(globalThis.destinationMounts??0)+1;
      await new Promise(resolve=>setTimeout(resolve,40));
      context.onNavigate(async (target,isCurrent)=>{
        if(!target||typeof target!=="object"||Array.isArray(target)||Object.keys(target).length!==1||typeof target.id!=="string")return {status:"unavailable",code:"invalid-target",message:"Destination target is invalid."};
        if(target.id==="slow"||target.id==="action-slow")await new Promise(resolve=>{globalThis.finishSlowNavigation=()=>{globalThis.finishSlowNavigation=undefined;resolve();};});
        if(!isCurrent())return {status:"unavailable",code:"session-ended",message:"Navigation was superseded."};
        globalThis.destinationTargets??=[];globalThis.destinationTargets.push(target.id);
        return {status:"opened",message:"Opened "+target.id+"."};
      });
      const status=context.ui.element("p");
      context.ui.navigationAction(container,{label:"Open current target",status,isCurrent:context.isCurrent,open:()=>context.navigation.openFeature("destination",{id:"action-slow"})});
      container.append(status);
      const shared=context.ui.element("p");
      context.ui.navigationAction(container,{label:"Open slow shared target",status:shared,isCurrent:context.isCurrent,open:async()=>{await new Promise(resolve=>{globalThis.finishSharedSlow=()=>{globalThis.finishSharedSlow=undefined;resolve();};});return {status:"opened",message:"Opened slow shared target."};}});
      context.ui.navigationAction(container,{label:"Open fast shared target",status:shared,isCurrent:context.isCurrent,open:async()=>({status:"opened",message:"Opened fast shared target."})});
      container.append(shared);
    }`); return;
  }
  if (request.url === "/reconnect.js") {
    response.setHeader("Content-Type", "text/javascript"); response.end(`globalThis.reconnectImports=(globalThis.reconnectImports??0)+1;
      await new Promise(resolve=>{globalThis.finishReconnectImport=resolve;});
      export function mount(container){globalThis.reconnectMounts=(globalThis.reconnectMounts??0)+1;const button=document.createElement("button"),status=document.createElement("p");button.textContent="Use reconnected feature";button.onclick=()=>{status.textContent="Reconnect feature is usable.";};container.append(button,status);}`); return;
  }
  if (request.url === "/v1/extensions") { response.end(JSON.stringify([feature, destination, reconnect])); return; }
  if (request.url === "/v1/extensions/reconnect/reconnect") { response.end(JSON.stringify(reconnect)); return; }
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
    import {createWorkspaceHosts} from '/workspace-hosts.js'; import {showFeaturePlugins,clearFeaturePlugins} from '/feature-panels.js'; import {beginBrowserSession} from '/session-boundary.js';
    beginBrowserSession(true);
    const hosts=createWorkspaceHosts(document.querySelector('#hosts'), async path=>(await fetch(path)).json());
    globalThis.fixture={hosts,clearFeaturePlugins};
    await hosts.refresh(['local'],true);
    await showFeaturePlugins({roles:['operator'],csrfToken:'fixture-csrf',capabilities:{operations:true}});
  ` });
   await page.getByRole('link', {name:'Open development on local',exact:true}).click();
   await page.locator(".workspace-row summary").getByText("Inline tools", { exact: true }).click();
   await page.getByText(`${firstId} running`, { exact: true }).waitFor();
   assert.equal(await page.evaluate("contexts[0].openFeature('not-installed')"), false);
   await page.locator('.workspace-feature').evaluate((details) => { if (details instanceof HTMLDetailsElement) details.open = false; });
   assert.equal(await page.evaluate("contexts[0].openFeature('inline')"), true);
   assert.equal(await page.locator('.workspace-feature').evaluate((details) => details instanceof HTMLDetailsElement && details.open), true);
     assert.equal(await page.locator("#feature-tabs a").count(), 2);
   const concurrent = await page.evaluate<WebNavigationResult[]>(`import("/navigation-broker.js").then(({navigation}) => Promise.all([
     navigation.openFeature("destination", {id:"first"}), navigation.openFeature("destination", {id:"second"})
   ]))`);
   assert.equal(await page.evaluate("destinationMounts"), 1);
   assert.deepEqual(concurrent.map((result) => result.status), ["unavailable", "opened"]);
    assert.deepEqual(await page.evaluate("destinationTargets"), ["second"]);
    const superseded = page.evaluate<WebNavigationResult>(`import("/navigation-broker.js").then(({navigation}) => navigation.openFeature("destination", {id:"slow"}))`);
    await page.waitForFunction("typeof finishSlowNavigation === 'function'");
    await page.evaluate(`import("/navigation-broker.js").then(({navigation}) => navigation.openFeature("destination", {id:"newer"}))`);
    await page.evaluate("finishSlowNavigation()");
    assert.equal((await superseded).status, "unavailable");
    assert.deepEqual(await page.evaluate("destinationTargets"), ["second", "newer"]);
    const navigationAction = page.getByRole("button", { name: "Open current target", exact: true });
    await navigationAction.click();
    await page.getByText("Opening destination", { exact: true }).waitFor();
    assert.equal(await navigationAction.isDisabled(), true);
    if (evidence) {
      for (const width of [1280, 768, 375]) {
        await page.setViewportSize({ width, height: 812 });
        await page.locator(".feature-page:visible").screenshot({ path: `${evidence}/navigation-action-pending-${width}.png` });
      }
    }
    await page.evaluate("finishSlowNavigation()");
    await page.getByText("Opened action-slow.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Open slow shared target", exact: true }).click();
    await page.waitForFunction("typeof finishSharedSlow === 'function'");
    await page.getByRole("button", { name: "Open fast shared target", exact: true }).click();
    await page.getByText("Opened fast shared target.", { exact: true }).waitFor();
    await page.evaluate("finishSharedSlow()");
    await page.waitForFunction("typeof finishSharedSlow === 'undefined'");
    assert.equal(await page.getByText("Opened fast shared target.", { exact: true }).count(), 1);
    if (evidence) {
      for (const width of [1280, 768, 375]) {
        await page.setViewportSize({ width, height: 812 });
        await page.locator(".feature-page:visible").screenshot({ path: `${evidence}/navigation-action-${width}.png` });
      }
      await page.setViewportSize({ width: 1280, height: 812 });
    }
     await page.getByRole("link", { name: "Workspaces", exact: true }).click();
     await page.getByRole("link", { name: "Reconnect race", exact: true }).click();
    await page.waitForFunction("typeof finishReconnectImport === 'function'");
    const reconnectResponse = page.waitForResponse("**/v1/extensions/reconnect/reconnect");
    await page.getByRole("button", { name: "Reconnect feature", exact: true }).click();
    await reconnectResponse;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.evaluate("finishReconnectImport()");
    await page.getByText(/Connection refreshed/).waitFor();
    assert.equal(await page.evaluate("reconnectImports"), 1);
    assert.equal(await page.evaluate("reconnectMounts"), 1);
    assert.equal(await page.getByRole("button", { name: "Use reconnected feature", exact: true }).count(), 1);
    await page.getByRole("button", { name: "Use reconnected feature", exact: true }).click();
    await page.getByText("Reconnect feature is usable.", { exact: true }).waitFor();
     await page.getByRole("link", { name: "Workspaces", exact: true }).click();
     await page.getByRole('link', {name:'Open development on local',exact:true}).click();
     await page.locator(".workspace-row summary").getByText("Inline tools", { exact: true }).click();
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
  assert.equal(await page.evaluate("contexts[0].navigation.hasFeature('destination')"), false);
  assert.equal(await page.evaluate("contexts[0].navigation.openFeature('destination',{id:'stale-workspace'}).then(result=>result.code)"), "session-ended");
  assert.equal(calls.length, 1);
   await page.getByRole('link', {name:'Open development on local',exact:true}).click();
  await page.locator(".workspace-row summary").getByText("Inline tools", { exact: true }).click();
  await page.getByText(`${secondId} running`, { exact: true }).waitFor();
  phase = "stopped";
  await page.getByLabel('Scoped draft',{exact:true}).fill('keep-through-phase-change');
  await page.evaluate("fixture.hosts.refresh(['local'],true)");
  assert.equal(await page.evaluate("disposals"), 1);
  await page.getByText(`${secondId} stopped`, { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Scoped draft',{exact:true}).inputValue(),'keep-through-phase-change');
  const pending = page.evaluate<WebNavigationResult>(`import("/navigation-broker.js").then(({navigation}) => navigation.openFeature("destination", {id:"slow"}))`);
  await page.waitForFunction("typeof finishSlowNavigation === 'function'");
  await page.evaluate("fixture.clearFeaturePlugins()");
  await page.evaluate("finishSlowNavigation()");
  assert.deepEqual(await pending, { status: "unavailable", code: "session-ended", message: "This navigation request ended with the browser session." });
  assert.equal(await page.evaluate("disposals"), 2);
  assert.equal(await page.evaluate("contexts[1].isCurrent()"), false);
  assert.equal(await page.getByRole("button", { name: "Start scoped server" }).count(), 0);
  assert.deepEqual(errors, []);
  process.stdout.write("Workspace plugin placement, exact UUID replacement, lifecycle disposal and session authorization passed.\n");
} finally { await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
