import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const assetNames = [
  "workspace-hosts.js",
  "workspace-create.js",
  "workspace-row.js",
  "workspace-ui.js",
  "workspace-features.js",
  "feature-ui.js",
  "feature-transport.js",
  "navigation-broker.js",
  "console-location.js",
  "session-data.js",
  "session-boundary.js",
] as const;
const assets = new Map<string, Buffer>(await Promise.all(assetNames.map(async (name) => [name, await readFile(new URL(`../../packages/web/core/src/assets/${name}`, import.meta.url))] as const)));
const workspaceId = "17094660-a627-4a17-acd2-6418c0b79967";
const server = createServer((request, response) => {
  const asset = assets.get(request.url?.slice(1) ?? "");
  if (asset) { response.setHeader("Content-Type", "text/javascript"); response.end(asset); return; }
  if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><main id="hosts"></main>'); return; }
  if (request.url === "/tools.js" || request.url === "/routes.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(`export function mount(container, context) { const heading=document.createElement('h3'); heading.textContent=context.location.path[0]==='routes'?'Routes studio':'Tools studio'; container.append(heading); }`);
    return;
  }
  response.statusCode = 404; response.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing fixture address");
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${address.port}/#/workspaces/local/${workspaceId}/tools`);
  await page.addScriptTag({ type: "module", content: `
    import { createWorkspaceHosts } from '/workspace-hosts.js';
    import { updateWorkspaceFeatures } from '/workspace-features.js';
    import { beginBrowserSession } from '/session-boundary.js';
    beginBrowserSession(true);
    const hosts=createWorkspaceHosts(document.querySelector('#hosts'), async()=>[{name:'development',id:${JSON.stringify(workspaceId)},phase:'running',runtime:'container',runtimeStatus:'running'}]);
    await hosts.refresh(['local'],true);
    updateWorkspaceFeatures([
      {id:'agent-tools',title:'Tools',description:'Tools',configured:true,status:'ready',browserEntry:'/tools.js',surfaces:['workspace'],operations:[{name:'read',description:'Read',access:'read'}]},
      {id:'external-urls',title:'External routes',description:'Routes',configured:true,status:'ready',browserEntry:'/routes.js',surfaces:['workspace'],operations:[{name:'read',description:'Read',access:'read'}]}
    ],{username:'operator',roles:['operator'],csrfToken:'csrf',capabilities:{operations:true}});
  ` });
  const row = page.locator(".workspace-row");
  await row.waitFor({ state: "attached" });
  if (!await row.isVisible()) throw new Error(`Deep-linked row remained hidden at ${page.url()}: ${await page.locator('body').innerHTML()} | ${errors.join(' | ')}`);
  assert.equal(await page.getByText("Workspace not found", { exact: true }).isVisible(), false);
  await page.getByRole("heading", { name: "Tools studio", exact: true }).waitFor();
  assert.equal(await page.locator('[data-feature-id="agent-tools"]').evaluate((details) => details instanceof HTMLDetailsElement && details.open), true);
  await row.getByRole("link", { name: "Routes", exact: true }).click();
  await page.getByRole("heading", { name: "Routes studio", exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, `#/workspaces/local/${workspaceId}/routes`);
  assert.equal(await page.locator('[data-feature-id="external-urls"]').evaluate((details) => details instanceof HTMLDetailsElement && details.open), true);
  assert.equal(await page.locator('[data-feature-id="agent-tools"]').evaluate((details) => details instanceof HTMLDetailsElement && details.open), false);
  assert.deepEqual(errors, []);
  process.stdout.write("workspace-deep-links: pre-load tools and routes open the exact UUID workspace without a not-found race PASS\n");
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
