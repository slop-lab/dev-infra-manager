import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { chromium } from "playwright-core";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const panel = await readFile(new URL("../../../../packages/web/plugins/agent-tools/src/assets/panel.js", import.meta.url));
const workspaceId = "17094660-a627-4a17-acd2-6418c0b79967", stoppedId = "27094660-a627-4a17-acd2-6418c0b79967";
const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
let installed = false, running = false, holdStatus = true;
let pending: ServerResponse | undefined, pendingCredential: ServerResponse | undefined, holdCredential = false;
let password = "private-server-password";
function status() { return { workspace: "development", workspaceId, state: running ? "running" : "stopped", port: 4096, url: "http://127.0.0.1:4096", username: "opencode", credentialsFile: "/home/agent/.local/state/dim/opencode-web/credentials", logFile: "/home/agent/.local/state/dim/opencode-web/server.log", externalUrlsAvailable: true, externalUrls: [{ url: "https://opencode.example.test:8443", permalink: "https://permanent.example.test/route/37094660-a627-4a17-acd2-6418c0b79967", ingress: "shared", approval: "approved" }, { url: "https://pending.example.test", ingress: "shared", approval: "pending" }] }; }
const server = createServer((request, response) => {
  if (request.url === "/panel.js") { response.setHeader("Content-Type", "text/javascript"); response.end(panel); return; }
  if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><div id="panel"></div>'); return; }
  if (request.url !== "/invoke" || request.method !== "POST") { response.statusCode = 404; response.end(); return; }
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const { name, input } = JSON.parse(Buffer.concat(chunks).toString()) as { name: string; input: Record<string, unknown> };
    calls.push({ name, input }); response.setHeader("Content-Type", "application/json");
    if (name === "controllers.list") { response.end(JSON.stringify({ controllers: [{ id: "local", title: "local", status: "ready", workspaces: [{ name: "development", id: workspaceId, phase: "running" }, { name: "offline", id: stoppedId, phase: "stopped" }], tools: ["opencode", "codex"] }] })); return; }
    if (name === "tools.setup") installed = true;
    if (name.startsWith("tools.")) { response.end(JSON.stringify({ workspace: "development", workspaceId, tools: [{ name: "opencode", installed, version: installed ? "1.18.31" : "" }] })); return; }
    if (name === "server.start") running = true;
    if (name === "server.stop") running = false;
    if (name === "server.credentials") { if (holdCredential) { pendingCredential = response; return; } response.end(JSON.stringify({ workspace: "development", workspaceId, username: "opencode", password })); return; }
    if (name === "server.password") password = String(input.password);
    if (name === "server.status" && holdStatus) { pending = response; return; }
    response.end(JSON.stringify(status()));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing browser fixture address");
const origin = `http://127.0.0.1:${address.port}`, browser = await chromium.launch({ executablePath, headless: true }), page = await browser.newPage();
const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
async function mount(operator: boolean, stopped = false) {
  await page.goto(origin);
  await page.addScriptTag({ type: "module", content: `import { mount } from '/panel.js';
    window.sessionCurrent = true;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText() { throw new Error('clipboard unavailable'); } } });
    window.disposePanel = mount(document.querySelector('#panel'), {
      operations: ${JSON.stringify(["controllers.list", "tools.status", "server.status", ...(operator ? ["tools.setup", "server.start", "server.stop", "server.credentials", "server.password"] : [])].map((name) => ({ name })))},
      isCurrent: () => window.sessionCurrent,
      workspace: ${JSON.stringify({hostId:"local",name:stopped ? "offline":"development",id:stopped ? stoppedId:workspaceId,phase:stopped ? "stopped":"running"})},
      async invoke(name, input) { const response = await fetch('/invoke', {method:'POST',body:JSON.stringify({name,input})}); return response.json(); }
    });` });
}
try {
  await mount(true);
  await page.getByText("opencode: not installed", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Install opencode", exact: true }).click();
  await page.getByText("opencode: 1.18.31", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Start OpenCode server", exact: true }).click();
  await page.getByText("Start OpenCode server completed.", { exact: true }).waitFor();
  await page.getByText("Server running. Port 4096 is inside the workspace.", { exact: true }).waitFor();
  const initialStatusResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.request().postDataJSON().name === "server.status");
  assert(pending); pending.end(JSON.stringify({ ...status(), state: "stopped" })); pending = undefined; holdStatus = false;
  await (await initialStatusResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  assert.equal(await page.getByText("Server running. Port 4096 is inside the workspace.", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await page.getByText("Refresh status completed.", { exact: true }).waitFor();
  assert.match(await page.locator("#panel").innerText(), /dim --host local forward development 4096:4096/);
  assert.equal(await page.getByRole("link", { name: "Open OpenCode Web", exact: true }).getAttribute("href"), "https://slop-lab.github.io/dev-infra-manager/opencode-web/");
  assert.equal(await page.locator('a[href^="http://127.0.0.1"]').count(), 0);
  assert.equal(await page.getByRole('link', { name: 'https://opencode.example.test:8443', exact: true }).getAttribute('href'), 'https://opencode.example.test:8443');
  assert.equal(await page.locator('a[href="https://pending.example.test"]').count(), 0);
  await page.getByText('Service URL:', { exact: false }).waitFor();
  await page.getByText('Permanent URL:', { exact: false }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'https://permanent.example.test/route/37094660-a627-4a17-acd2-6418c0b79967', exact: true }).count(), 1);
  assert.equal(calls.filter(({ name }) => name === 'server.credentials').length, 0);
  await page.getByRole('button', { name: 'Copy server password', exact: true }).click();
  const fallback = page.getByLabel('Select and copy server password'); await fallback.waitFor();
  assert.equal(await fallback.inputValue(), password);
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  assert.equal(await fallback.count(), 0);
  await page.getByLabel('New server password', { exact: true }).fill('updated-secret-password');
  await page.getByRole('button', { name: 'Set server password', exact: true }).click();
  await page.getByText('Set server password completed.', { exact: true }).waitFor();
  assert.equal(password, 'updated-secret-password');
  assert.equal(await page.getByLabel('New server password', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('input').evaluateAll((inputs) => inputs.some((input) => (input as HTMLInputElement).value === 'updated-secret-password')), false);
  await page.getByRole("button", { name: "Stop OpenCode server", exact: true }).click();
  await page.getByText("Server stopped. Port 4096 is inside the workspace.", { exact: true }).waitFor();
  assert.equal(await page.locator("select").count(), 0);
  await mount(true, true);
  await page.getByText("Start this workspace from Workspaces before inspecting or installing tools.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Start OpenCode server", exact: true }).count(), 0);
  for (const call of calls.filter(({ name }) => name !== "controllers.list")) assert.deepEqual({ workspace: call.input.workspace, workspaceId: call.input.workspaceId, controllerId: call.input.controllerId }, { workspace: "development", workspaceId, controllerId: "local" });
  await mount(false);
  await page.getByText("opencode: 1.18.31", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Install opencode", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Start OpenCode server", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Copy server password", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("New server password", { exact: true }).count(), 0);
  await mount(true); await page.getByRole('button', { name: 'Copy server password', exact: true }).waitFor(); holdCredential = true;
  const credentialRequest = page.waitForRequest((request) => request.method() === 'POST' && request.postDataJSON().name === 'server.credentials');
  await page.getByRole('button', { name: 'Copy server password', exact: true }).click();
  await credentialRequest;
  assert(pendingCredential); await page.evaluate('window.sessionCurrent = false; window.disposePanel();');
  const staleResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.request().postDataJSON().name === 'server.credentials');
  pendingCredential.end(JSON.stringify({ workspace: 'development', workspaceId, username: 'opencode', password })); pendingCredential = undefined;
  await (await staleResponse).finished();
  assert.equal(await page.locator('#panel input').count(), 0);
  assert.deepEqual(errors, []);
  process.stdout.write("Workspace tool installation, OpenCode lifecycle, scoped identities and read-only browser controls passed.\n");
} finally {
  pending?.end(JSON.stringify(status()));
  pendingCredential?.end('{}');
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
}
