import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { initializeFeaturesWeb } from "../../packages/web/core/src/initialize.js";
import { createWebServerFromConfigFile } from "../../packages/web/core/src/server.js";
import { availablePort } from "./webHarness.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const root = await mkdtemp(join(tmpdir(), "dim-controller-output-browser-"));
const directory = join(root, "node_modules/fixture-output"), executable = join(root, "controller.mjs");
const mutations = join(root, "mutations.json"), calls = join(root, "calls.json");
const secret = "SYNTHETIC_PRIVATE_STDERR_SENTINEL", largeBytes = 3.5 * 1024 * 1024;
await mkdir(directory, { recursive: true });
await writeFile(mutations, "0"); await writeFile(calls, "[]");
await writeFile(executable, `#!${process.execPath}
// @ts-check
import fs from 'node:fs';
const args=process.argv.slice(2),callsFile=${JSON.stringify(calls)},mutationFile=${JSON.stringify(mutations)};
const calls=JSON.parse(fs.readFileSync(callsFile,'utf8'));calls.push(args);fs.writeFileSync(callsFile,JSON.stringify(calls));
if(args[0]!=='--host'||args[1]!=='selected-host'||args.at(-1)!=='--json')throw Error('invalid controller scope');
if(args[2]==='ls')console.log('[]');
else if(args[2]!=='fixture')throw Error('invalid controller command');
else if(args[3]==='discover')console.log(JSON.stringify({ready:true}));
else if(args[3]==='large')console.log(JSON.stringify({reviewId:'review-receipt',patch:'x'.repeat(${largeBytes})}));
else if(args[3]==='mutate'){
 fs.writeFileSync(mutationFile,String(Number(fs.readFileSync(mutationFile,'utf8'))+1));
 process.stderr.write(${JSON.stringify(secret + " /private/controller/diagnostic\n")});
 console.log(JSON.stringify({accepted:true,patch:'x'.repeat(33*1024*1024)}));
}else throw Error('unknown operation');
`, { mode: 0o700 });
await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fixture-output", type: "module", main: "index.js" }));
await writeFile(join(directory, "index.js"), `// @ts-check
const operations=['large','mutate'].map(name=>({name,description:'Bounded output fixture',access:name==='large'?'read':'operator',parseInput(value){if(!value||typeof value!=='object'||Object.keys(value).length)throw Error('invalid input');return value;},parseOutput(value){return value;}}));
export const webPlugin={id:'fixture-output',title:'Output fixture',description:'Actual child-process output',operations,assets:{'panel.js':new URL('./panel.js',import.meta.url)},browserEntry:'panel.js',async create(){throw Error('Manual fixture configuration is unsupported');},async autoConnect(context){const controller=context.controllers[0];if(!controller)throw Error('missing controller');await controller.run(['fixture','discover']);return{invoke(name){return controller.run(['fixture',name]);}};}};
`);
await writeFile(join(directory, "panel.js"), `// @ts-check
export function mount(container,context){globalThis.fixtureOutputInvoke=context.invoke;container.textContent='Output fixture ready';}
`);
const specification = join(root, "features.json"), config = join(root, "web.json");
await writeFile(specification, JSON.stringify({ pluginHome: root, plugins: [{ package: "fixture-output" }] }), { mode: 0o600 });
const credentials = await initializeFeaturesWeb({ specification, roles: ["read", "operator"], output: config, port: await availablePort() });
const saved: unknown = JSON.parse(await readFile(config, "utf8"));
assert(saved && typeof saved === "object" && !Array.isArray(saved));
await writeFile(config, JSON.stringify({ ...saved, operations: { hosts: [{ id: "controller", selector: "selected-host", executable }] } }), { mode: 0o600 });
const web = await createWebServerFromConfigFile(config), origin = await web.listen();
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage(), errors: string[] = [], dispatched: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { const operation = /\/fixture-output\/operations\/(large|mutate)$/.exec(request.url())?.[1]; if (operation) dispatched.push(operation); });
  await page.goto(origin);
  await page.getByLabel("Username", { exact: true }).fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Output fixture", exact: true }).click();
  await page.getByText("Output fixture ready", { exact: true }).waitFor();
  async function invoke(name: "large" | "mutate") {
    return page.evaluate(async operation => {
      const invoke = (globalThis as unknown as { fixtureOutputInvoke(name: string, input: unknown, options: unknown): Promise<unknown> }).fixtureOutputInvoke;
      try {
        const value: unknown = await invoke(operation, {}, { timeoutMilliseconds: 30_000 });
        if (!value || typeof value !== "object" || !("patch" in value) || typeof value.patch !== "string") throw new Error("invalid fixture result");
        return { patchBytes: new TextEncoder().encode(value.patch).byteLength, first: value.patch.at(0), last: value.patch.at(-1), receipt: "reviewId" in value ? value.reviewId : null };
      } catch (error) { return { error: error instanceof Error ? error.message : "unknown", outcome: error instanceof Error && "outcome" in error ? error.outcome : null }; }
    }, name);
  }
  const largeResponse = page.waitForResponse(response => response.url().endsWith("/fixture-output/operations/large"));
  assert.deepEqual(await invoke("large"), { patchBytes: largeBytes, first: "x", last: "x", receipt: "review-receipt" });
  assert.equal((await largeResponse).status(), 200);
  assert(largeBytes > 2 * 1024 * 1024 && largeBytes < 32 * 1024 * 1024);
  let errorBody = "";
  await page.route("**/fixture-output/operations/mutate", async route => {
    const actual = await route.fetch(); errorBody = await actual.text();
    await route.fulfill({ response: actual });
  });
  const mutationResponse = page.waitForResponse(response => response.url().endsWith("/fixture-output/operations/mutate"));
  const failed = await invoke("mutate"), response = await mutationResponse;
  assert.equal(response.status(), 502);
  assert.equal(failed.outcome, "unknown");
  assert.match(failed.error ?? "", /outcome is unknown.*refresh/i);
  assert.equal((await readFile(mutations, "utf8")).trim(), "1", "overflow must not imply that the mutation was rejected");
  assert.deepEqual(dispatched, ["large", "mutate"], "uncertain mutations must not be automatically resubmitted");
  assert.match(errorBody, /may have completed.*refresh/i);
  assert.equal(errorBody.includes(secret), false); assert.equal(errorBody.includes("/private/controller/diagnostic"), false);
  assert.equal(JSON.stringify(failed).includes(secret), false);
  const recorded = JSON.parse(await readFile(calls, "utf8")) as string[][];
  assert.deepEqual(recorded.filter(args => args[2] === "fixture").map(args => args[3]), ["discover", "large", "mutate"]);
  assert.deepEqual(errors, []);
  console.log("Browser controller transport: >2MiB JSON succeeded; >32MiB accepted mutation returned 502/unknown without private stderr or retry.");
} finally { await browser.close(); await web.close(); await rm(root, { recursive: true, force: true }); }
