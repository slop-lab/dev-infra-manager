import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { initializeFeaturesWeb } from "../../packages/web/core/src/initialize.js";
import { createWebServerFromConfigFile } from "../../packages/web/core/src/server.js";
import { availablePort } from "./webHarness.js";
const executablePath = process.env.DIM_CHROMIUM; if (!executablePath) throw new Error("DIM_CHROMIUM is required");
const root = await mkdtemp(join(tmpdir(), "dim-browser-deadline-")), directory = join(root, "node_modules/fixture-feature");
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture-feature", type: "module", main: "index.js" }));
await writeFile(join(directory, "index.js"), `const operation={name:'slow',description:'Deadline fixture',access:'operator',parseInput(v){return v;},parseOutput(v){return v;}};export const webPlugin={id:'fixture',title:'Fixture',description:'Deadline fixture',operations:[operation],assets:{'panel.js':new URL('./panel.js',import.meta.url)},browserEntry:'panel.js',async create(){return {async invoke(){await new Promise(resolve=>setTimeout(resolve,100));return {};}};}};`);
await writeFile(join(directory, "panel.js"), `// @ts-check\nexport function mount(container,context){globalThis.fixtureInvoke=context.invoke;container.textContent='Deadline fixture ready';}`);
const specification = join(root, "features.json"), config = join(root, "web.json");
await writeFile(specification, JSON.stringify({ pluginHome: root, plugins: [{ package: "fixture-feature", config: {} }] }), { mode: 0o600 });
const credentials = await initializeFeaturesWeb({ specification, roles: ["operator"], output: config, port: await availablePort() });
const web = await createWebServerFromConfigFile(config), origin = await web.listen(), browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage(); let dispatched = 0;
  page.on("request", (request) => { if (request.url().endsWith("/operations/slow")) dispatched++; });
  await page.goto(origin); await page.getByLabel("Username", { exact: true }).fill(credentials.username); await page.getByLabel("Password", { exact: true }).fill(credentials.password); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Deadline fixture ready", { exact: true }).waitFor();
  async function invoke(options: unknown) {
    return page.evaluate(async (options) => {
      const invoke = (globalThis as unknown as { fixtureInvoke(name: string, input: unknown, options: unknown): Promise<unknown> }).fixtureInvoke;
      try { return { result: await invoke("slow", {}, options) }; } catch (error) { return { error: String(error), outcome: error instanceof Error && 'outcome' in error ? error.outcome : null }; }
    }, options);
  }
  for (const options of [{ timeoutMilliseconds: 0 }, { timeoutMilliseconds: -1 }, { timeoutMilliseconds: 185001 }, { timeoutMilliseconds: 1.5 }, { timeoutMilliseconds: 100, unexpected: true }]) assert.match(String((await invoke(options)).error), /Invalid feature request timeout/);
  assert.equal(dispatched, 0);
  assert.equal((await invoke({ timeoutMilliseconds: 20 })).outcome, 'unknown');
  assert.deepEqual((await invoke({ timeoutMilliseconds: 500 })).result, {}); assert.equal(dispatched, 2);
  process.stdout.write("Generic browser invoke: invalid options reject before dispatch; explicit deadline abort and valid deadline passed.\n");
} finally { await browser.close(); await web.close(); await rm(root, { recursive: true, force: true }); }
