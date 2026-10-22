import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const source = await readFile(new URL("../../../packages/web/plugins/execution/src/assets/panel.js", import.meta.url), "utf8");
const uiSource = await readFile(new URL("../../../packages/web/core/src/assets/feature-ui.js", import.meta.url), "utf8");
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage(); page.setDefaultTimeout(10_000);
const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
type Input = { controllerId?: string; id?: string; requestId?: string };
const calls: Array<{ name: string; input: Input }> = [];
const descriptors = ["controllers.list", "jobs.list", "jobs.detail", "jobs.retry", "workers.list"].map((name) => ({ name, description: name, access: "read" }));
let holdDetail = false, releaseDetail: () => void = () => {}, markDetail: () => void = () => {};
const detailGate = new Promise<void>((resolve) => { releaseDetail = resolve; });
const detailStarted = new Promise<void>((resolve) => { markDetail = resolve; });
let failRetry = true;
const job = { id: "same-id", jobName: "Shared job", phase: "finished", outcome: "passed", projectId: "sample", repositoryId: "root", createdAt: new Date().toISOString(), publication: "none" };
try {
  await page.exposeFunction("executionInvoke", async (name: string, input: Input) => {
    calls.push({ name, input });
    if (name === "controllers.list") return { controllers: [
      { id: "first", title: "First", status: "ready", operations: descriptors },
      { id: "second", title: "Second", status: "ready", operations: descriptors },
      { id: "read-only", title: "Read only", status: "ready", operations: descriptors.filter((value) => ["jobs.list", "jobs.detail"].includes(value.name)) },
      { id: "offline", title: "Offline", status: "unavailable", operations: [] }
    ] };
    if (name === "jobs.list") return [{ ...job, jobName: `${input.controllerId} job` }];
    if (name === "jobs.detail") {
      if (holdDetail) { holdDetail = false; markDetail(); await detailGate; }
      return { job: { ...job, jobName: `${input.controllerId} detail` }, result: null };
    }
    if (name === "jobs.retry") { if (failRetry) { failRetry = false; throw new Error("response lost"); } return {}; }
    if (name === "workers.list") return [];
    throw new Error("unexpected operation");
  });
  await page.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
  await page.goto("http://localhost/");
  await page.evaluate(`(async () => {
    const module = await import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)});
    const { featureUi } = await import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(uiSource).toString("base64")}`)});
    module.mount(document.querySelector("main"), {
      operations: ${JSON.stringify(descriptors)},
      invoke: (name, input) => window.executionInvoke(name, input), isCurrent: () => true, ui: featureUi
    });
  })()`);
  await page.getByRole("cell", { name: "first job", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Worker capacity", exact: true }).waitFor();
  await page.getByLabel("Search jobs", { exact: true }).fill("missing");
  await page.getByText("No jobs match the current search and state filter.", { exact: true }).waitFor();
  await page.getByLabel("Search jobs", { exact: true }).fill("first");
  await page.getByRole("button", { name: "View job", exact: true }).click();
  await page.getByRole("heading", { name: "first detail — finished", exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry execution", exact: true }).click();
  await page.getByText(/^Retry execution failed:/).waitFor();
  await page.getByRole("button", { name: "Retry execution", exact: true }).click();
  await page.getByText("Retry execution accepted.", { exact: true }).waitFor();
  const firstRetries = calls.filter((call) => call.name === "jobs.retry");
  assert.equal(firstRetries.length, 2); assert.equal(firstRetries[0]?.input.requestId, firstRetries[1]?.input.requestId);
  await page.getByLabel("Controller", { exact: true }).selectOption("second");
  await page.getByRole("cell", { name: "second job", exact: true }).waitFor();
  await page.getByRole("button", { name: "View job", exact: true }).click();
  await page.getByRole("heading", { name: "second detail — finished", exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry execution", exact: true }).click();
  await page.getByText("Retry execution accepted.", { exact: true }).waitFor();
  const secondRetry = calls.find((call) => call.name === "jobs.retry" && call.input.controllerId === "second");
  assert(secondRetry); assert.notEqual(secondRetry.input.requestId, firstRetries[0]?.input.requestId);
  holdDetail = true;
  await page.getByRole("button", { name: "View job", exact: true }).click(); await detailStarted;
  await page.getByLabel("Controller", { exact: true }).selectOption("read-only");
  await page.getByRole("cell", { name: "read-only job", exact: true }).waitFor();
  releaseDetail();
  await page.getByRole("button", { name: "View job", exact: true }).click();
  await page.getByRole("heading", { name: "read-only detail — finished", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry execution", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Refresh worker capacity", exact: true }).count(), 0);
  assert.equal(await page.getByRole("heading", { name: "second detail — finished", exact: true }).count(), 0);
  await page.getByLabel("Controller", { exact: true }).selectOption("offline");
  await page.getByText(/^Execution is unavailable on this controller/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Refresh jobs", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Refresh controllers", exact: true }).click();
  await page.getByText(/^Execution is unavailable on this controller/).waitFor();
  assert.equal(await page.getByLabel("Controller", { exact: true }).inputValue(), "offline");
  assert(calls.filter((call) => call.name !== "controllers.list").every((call) => typeof call.input.controllerId === "string"));
  assert.deepEqual(errors, []);
  process.stdout.write("Execution controller discovery, permissions, retry scopes and stale-response isolation passed.\n");
} finally { releaseDetail(); await browser.close(); }
