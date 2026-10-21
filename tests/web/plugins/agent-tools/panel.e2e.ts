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
let pending: ServerResponse | undefined;
function status() { return { workspace: "development", workspaceId, state: running ? "running" : "stopped", port: 4096, url: "http://127.0.0.1:4096", username: "opencode", credentialsFile: "/home/agent/.local/state/dim/opencode-web/credentials", logFile: "/home/agent/.local/state/dim/opencode-web/server.log" }; }
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
    if (name === "server.status" && holdStatus) { pending = response; return; }
    response.end(JSON.stringify(status()));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing browser fixture address");
const origin = `http://127.0.0.1:${address.port}`, browser = await chromium.launch({ executablePath, headless: true }), page = await browser.newPage();
const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
async function mount(operator: boolean) {
  await page.goto(origin);
  await page.addScriptTag({ type: "module", content: `import { mount } from '/panel.js';
    mount(document.querySelector('#panel'), {
      operations: ${JSON.stringify(["controllers.list", "tools.status", "server.status", ...(operator ? ["tools.setup", "server.start", "server.stop"] : [])].map((name) => ({ name })))},
      isCurrent: () => true,
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
  await page.getByRole("button", { name: "Stop OpenCode server", exact: true }).click();
  await page.getByText("Server stopped. Port 4096 is inside the workspace.", { exact: true }).waitFor();
  await page.getByLabel("Workspace", { exact: true }).selectOption(stoppedId);
  await page.getByText("Start this workspace from Workspaces before inspecting or installing tools.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Start OpenCode server", exact: true }).count(), 0);
  for (const call of calls.filter(({ name }) => name !== "controllers.list")) assert.deepEqual({ workspace: call.input.workspace, workspaceId: call.input.workspaceId, controllerId: call.input.controllerId }, { workspace: "development", workspaceId, controllerId: "local" });
  await mount(false);
  await page.getByText("opencode: 1.18.31", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Install opencode", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Start OpenCode server", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  process.stdout.write("Workspace tool installation, OpenCode lifecycle, scoped identities and read-only browser controls passed.\n");
} finally {
  pending?.end(JSON.stringify(status()));
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve()));
}
