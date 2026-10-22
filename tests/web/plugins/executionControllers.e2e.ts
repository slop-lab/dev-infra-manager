import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const source = await readFile(new URL("../../../packages/web/plugins/execution/src/assets/panel.js", import.meta.url), "utf8");
const navigationSource = await readFile(new URL("../../../packages/web/plugins/execution/src/assets/navigation.js", import.meta.url), "utf8");
const panelSource = source.replace('"./navigation.js"', JSON.stringify(`data:text/javascript;base64,${Buffer.from(navigationSource).toString("base64")}`));
const uiSource = await readFile(new URL("../../../packages/web/core/src/assets/feature-ui.js", import.meta.url), "utf8");
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage(); page.setDefaultTimeout(10_000);
const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
type Input = { controllerId?: string; id?: string; requestId?: string };
const calls: Array<{ name: string; input: Input }> = [];
const descriptors = ["controllers.list", "jobs.list", "jobs.detail", "jobs.retry", "workers.list"].map((name) => ({ name, description: name, access: "read" }));
let failInitialJobs = true, includeNavigationJob = false, failDiscovery = false, emptyWorkers = false, queuedDetail = false;
let heldJobs: "manual" | "discovery" | undefined;
let releaseManualJobs: () => void = () => {}, markManualJobs: () => void = () => {};
let releaseDiscoveryJobs: () => void = () => {}, markDiscoveryJobs: () => void = () => {};
const manualJobsGate = new Promise<void>((resolve) => { releaseManualJobs = resolve; });
const manualJobsStarted = new Promise<void>((resolve) => { markManualJobs = resolve; });
const discoveryJobsGate = new Promise<void>((resolve) => { releaseDiscoveryJobs = resolve; });
const discoveryJobsStarted = new Promise<void>((resolve) => { markDiscoveryJobs = resolve; });
let holdDetail = false, releaseDetail: () => void = () => {}, markDetail: () => void = () => {};
const detailGate = new Promise<void>((resolve) => { releaseDetail = resolve; });
const detailStarted = new Promise<void>((resolve) => { markDetail = resolve; });
let failRetry = true;
let holdStaleRefresh = false, releaseStaleRefresh: () => void = () => {}, markStaleRefresh: () => void = () => {};
const staleRefreshGate = new Promise<void>((resolve) => { releaseStaleRefresh = resolve; });
const staleRefreshStarted = new Promise<void>((resolve) => { markStaleRefresh = resolve; });
const job = { id: "00000000-0000-4000-8000-000000000001", jobName: "Shared job", executionKind: "ordinary-sysbox", phase: "finished", outcome: "passed", projectId: "sample", repositoryId: "root", createdAt: new Date().toISOString(), publication: "none" };
const navigationJob = { ...job, id: "00000000-0000-4000-8000-000000000002", jobName: "Navigation job" };
try {
  await page.exposeFunction("executionInvoke", async (name: string, input: Input) => {
    calls.push({ name, input });
    if (name === "controllers.list") {
      if (failDiscovery) { failDiscovery = false; throw new Error("controller discovery unavailable"); }
      return { controllers: [
      { id: "first", controllerKey: "first", title: "First", status: "ready", operations: descriptors },
      { id: "second", controllerKey: "second", title: "Second", status: "ready", operations: descriptors },
      { id: "read-only", controllerKey: "read-only", title: "Read only", status: "ready", operations: descriptors.filter((value) => ["jobs.list", "jobs.detail"].includes(value.name)) },
      { id: "offline", controllerKey: "offline", title: "Offline", status: "unavailable", operations: [] }
      ] };
    }
    if (name === "jobs.list") {
      if (failInitialJobs) { failInitialJobs = false; throw new Error("initial jobs unavailable"); }
      if (holdStaleRefresh) { holdStaleRefresh = false; const snapshot = [{ ...job, jobName: `${input.controllerId} job` }]; markStaleRefresh(); await staleRefreshGate; return snapshot; }
      if (heldJobs === "manual") { heldJobs = undefined; markManualJobs(); await manualJobsGate; }
      if (heldJobs === "discovery") { heldJobs = undefined; markDiscoveryJobs(); await discoveryJobsGate; }
      return [{ ...job, jobName: `${input.controllerId} job` }, ...(includeNavigationJob ? [{ ...navigationJob, jobName: `${input.controllerId} navigation job` }] : [])];
    }
    if (name === "jobs.detail") {
      if (holdDetail) { holdDetail = false; markDetail(); await detailGate; }
      const selectedJob = input.id === navigationJob.id ? navigationJob : job;
      return { job: { ...selectedJob, jobName: `${input.controllerId} detail`, ...(queuedDetail ? { phase: "queued" } : {}) }, result: null };
    }
    if (name === "jobs.retry") { if (failRetry) { failRetry = false; throw new Error("response lost"); } return {}; }
    if (name === "workers.list") return emptyWorkers ? [] : [{ id: "worker-a", slots: [
      { id: "ci", state: "busy", executionKind: "ordinary-sysbox", job: { ...job, jobName: `${input.controllerId} worker job` } },
      { id: "task", state: "busy", executionKind: "task/review", job: { id: crypto.randomUUID(), taskType: "review-predicate", executionKind: "task/review", phase: "running" } }
    ] }];
    throw new Error("unexpected operation");
  });
  await page.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: "<main></main>" }));
  await page.goto("http://localhost/");
  await page.evaluate(`(async () => {
    const module = await import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(panelSource).toString("base64")}`)});
    const { featureUi } = await import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(uiSource).toString("base64")}`)});
    window.disposeExecution = module.mount(document.querySelector("main"), {
      operations: ${JSON.stringify(descriptors)},
      invoke: (name, input) => window.executionInvoke(name, input), isCurrent: () => true, ui: featureUi,
      navigation: { canCreateWorkspace: false, hasFeature: () => false, openFeature: async () => ({ status: "unavailable", code: "not-installed", message: "Unavailable" }), openWorkspaceCreate: async () => ({ status: "unavailable", code: "not-installed", message: "Unavailable" }) },
      onNavigate: (handler) => { window.executionNavigate = handler; return () => { delete window.executionNavigate; }; }
    });
  })()`);
  await page.getByText(/^Could not load jobs: initial jobs unavailable/).waitFor();
  await page.getByRole("button", { name: "Refresh jobs", exact: true }).click();
  await page.getByRole("cell", { name: "first job", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Worker capacity", exact: true }).waitFor();
  await page.getByText("review-predicate / task/review", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "View worker job", exact: true }).count(), 1);
  await page.getByRole("button", { name: "View worker job", exact: true }).click();
  await page.getByRole("heading", { name: "first detail — finished", exact: true }).waitFor();
  const invalidTarget = await page.evaluate(`window.executionNavigate?.({ kind: "job", controllerKey: "first", jobId: ${JSON.stringify(job.id)}, extra: true }, () => true)`);
  assert.deepEqual(invalidTarget, { status: "unavailable", code: "invalid-target", message: "The navigation target is invalid." });
  const repositoryTarget = await page.evaluate(`window.executionNavigate?.({ kind: "repository-jobs", controllerKey: "first", projectId: "sample", repositoryId: "root" }, () => true)`);
  assert.deepEqual(repositoryTarget, { status: "opened", message: "Opened jobs for sample/root." });
  await page.getByText("Showing jobs for sample/root.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Clear repository filter", exact: true }).click();
  holdStaleRefresh = true;
  await page.getByRole("button", { name: "Refresh jobs", exact: true }).click();
  await staleRefreshStarted;
  includeNavigationJob = true;
  const freshJobTarget = await page.evaluate(`window.executionNavigate?.({ kind: "job", controllerKey: "first", jobId: ${JSON.stringify(navigationJob.id)} }, () => true)`);
  assert.deepEqual(freshJobTarget, { status: "opened", message: `Opened execution job ${navigationJob.id}.` });
  await page.getByRole("cell", { name: "first navigation job", exact: true }).waitFor();
  releaseStaleRefresh();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Refresh jobs" && !button.disabled));
  assert.equal(await page.getByRole("cell", { name: "first navigation job", exact: true }).count(), 1);
  await page.getByRole("heading", { name: "first detail — finished", exact: true }).waitFor();
  const missingRepository = await page.evaluate(`window.executionNavigate?.({ kind: "repository-jobs", controllerKey: "second", projectId: "missing", repositoryId: "root" }, () => true)`);
  assert.deepEqual(missingRepository, { status: "unavailable", code: "target-unavailable", message: "The requested execution target is unavailable." });
  assert.equal(await page.getByLabel("Controller", { exact: true }).inputValue(), "first");
  heldJobs = "manual";
  const heldManualTarget = page.evaluate(`window.executionNavigate?.({ kind: "repository-jobs", controllerKey: "second", projectId: "sample", repositoryId: "root" }, () => true)`);
  await manualJobsStarted;
  await page.getByLabel("Controller", { exact: true }).selectOption("read-only");
  await page.getByRole("cell", { name: "read-only job", exact: true }).waitFor();
  releaseManualJobs();
  assert.deepEqual(await heldManualTarget, { status: "unavailable", code: "target-unavailable", message: "The requested execution target is unavailable." });
  assert.equal(await page.getByLabel("Controller", { exact: true }).inputValue(), "read-only");
  await page.getByLabel("Controller", { exact: true }).selectOption("first");
  await page.getByRole("cell", { name: "first job", exact: true }).waitFor();
  heldJobs = "discovery";
  const heldDiscoveryTarget = page.evaluate(`window.executionNavigate?.({ kind: "repository-jobs", controllerKey: "second", projectId: "sample", repositoryId: "root" }, () => true)`);
  await discoveryJobsStarted;
  failDiscovery = true;
  await page.getByRole("button", { name: "Refresh controllers", exact: true }).click();
  await page.getByText(/^Could not discover execution services:/).waitFor();
  releaseDiscoveryJobs();
  assert.deepEqual(await heldDiscoveryTarget, { status: "unavailable", code: "target-unavailable", message: "The requested execution target is unavailable." });
  assert.equal(await page.getByText("Showing jobs for sample/root.", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("cell", { name: "second job", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Refresh controllers", exact: true }).click();
  await page.getByRole("cell", { name: "first job", exact: true }).waitFor();
  await page.getByLabel("Search jobs", { exact: true }).fill("missing");
  await page.getByText("No jobs match the current search and state filter.", { exact: true }).waitFor();
  await page.getByLabel("Search jobs", { exact: true }).fill("first");
  await page.getByRole("row", { name: /first job sample\/root/ }).getByRole("button", { name: "View job", exact: true }).click();
  await page.getByRole("heading", { name: "first detail — finished", exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry execution", exact: true }).click();
  await page.getByText(/^Retry execution failed:/).waitFor();
  await page.getByRole("button", { name: "Retry execution", exact: true }).click();
  await page.getByText("Retry execution accepted.", { exact: true }).waitFor();
  const firstRetries = calls.filter((call) => call.name === "jobs.retry");
  assert.equal(firstRetries.length, 2); assert.equal(firstRetries[0]?.input.requestId, firstRetries[1]?.input.requestId);
  await page.getByLabel("Controller", { exact: true }).selectOption("second");
  await page.getByRole("cell", { name: "second job", exact: true }).waitFor();
  await page.getByRole("row", { name: /second job sample\/root/ }).getByRole("button", { name: "View job", exact: true }).click();
  await page.getByRole("heading", { name: "second detail — finished", exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry execution", exact: true }).click();
  await page.getByText("Retry execution accepted.", { exact: true }).waitFor();
  const secondRetry = calls.find((call) => call.name === "jobs.retry" && call.input.controllerId === "second");
  assert(secondRetry); assert.notEqual(secondRetry.input.requestId, firstRetries[0]?.input.requestId);
  emptyWorkers = true;
  await page.getByRole("button", { name: "Refresh worker capacity", exact: true }).click();
  await page.getByText(/^No execution workers configured/).waitFor();
  await page.getByText("Set up execution workers", { exact: true }).click();
  await page.getByText("dim execution worker /absolute/path/to/worker.json", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Execution worker setup guide", exact: true }).getAttribute("href"), "https://github.com/slop-lab/dev-infra-manager/blob/development/docs/guides/ci-runners.md");
  queuedDetail = true;
  await page.getByRole("row", { name: /second job sample\/root/ }).getByRole("button", { name: "View job", exact: true }).click();
  await page.getByText(/^Waiting for an active worker with a matching ordinary-sysbox slot/).waitFor();
  queuedDetail = false;
  holdDetail = true;
  await page.getByRole("row", { name: /second job sample\/root/ }).getByRole("button", { name: "View job", exact: true }).click(); await detailStarted;
  await page.getByLabel("Controller", { exact: true }).selectOption("read-only");
  await page.getByRole("cell", { name: "read-only job", exact: true }).waitFor();
  releaseDetail();
  await page.getByRole("row", { name: /read-only job sample\/root/ }).getByRole("button", { name: "View job", exact: true }).click();
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
  assert.equal(await page.evaluate(`window.disposeExecution(); typeof window.executionNavigate`), "undefined");
  assert.deepEqual(errors, []);
  process.stdout.write("Execution controller discovery, permissions, retry scopes and stale-response isolation passed.\n");
} finally { releaseDetail(); await browser.close(); }
