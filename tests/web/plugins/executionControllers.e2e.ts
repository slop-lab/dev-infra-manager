import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import {assertBrowserRoleExecutionAuthority,assertDirectExecutionAuthority,assertReadOnlyExecutionAuthority,assertWorkerOnlyExecutionAccess} from './executionPermissions.js';
import {loadExecutionBrowserAssets} from './executionBrowserAssets.js';
const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const {panelSource,uiSource,styles} = await loadExecutionBrowserAssets();
const evidence = process.env.DIM_WEB_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(10_000);
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
       { id: 'operator-only', controllerKey: 'operator-only', title: 'Operator only', status: 'ready', operations: descriptors.filter(({name}) => name === 'workers.list') },
      { id: "offline", controllerKey: "offline", title: "Offline", status: "unavailable", operations: [] }
      ] };
    }
    if (name === "jobs.list") {
      if (failInitialJobs) { failInitialJobs = false; throw new Error("initial jobs unavailable"); }
      if (holdStaleRefresh) { holdStaleRefresh = false; const snapshot = [{ ...job, jobName: `${input.controllerId} job` }]; markStaleRefresh(); await staleRefreshGate; return snapshot; }
      if (heldJobs === "manual") { heldJobs = undefined; markManualJobs(); await manualJobsGate; }
      if (heldJobs === "discovery") { heldJobs = undefined; markDiscoveryJobs(); await discoveryJobsGate; }
      return [{ ...job, jobName: `${input.controllerId ?? 'direct'} job` }, ...(includeNavigationJob ? [{ ...navigationJob, jobName: `${input.controllerId ?? 'direct'} navigation job` }] : [])];
    }
    if (name === "jobs.detail") {
      if (holdDetail) { holdDetail = false; markDetail(); await detailGate; }
      const selectedJob = input.id === navigationJob.id ? navigationJob : job;
      return { job: { ...selectedJob, jobName: `${input.controllerId ?? 'direct'} detail`, ...(queuedDetail ? { phase: "queued" } : {}) }, result: null };
    }
    if (name === "jobs.retry") { if (failRetry) { failRetry = false; throw new Error("response lost"); } return {}; }
    if (name === "workers.list") return emptyWorkers ? [] : [{ id: "worker-a", slots: [
      { id: "ci", state: "busy", executionKind: "ordinary-sysbox", job: { ...job, jobName: `${input.controllerId} worker job` } },
      { id: "task", state: "busy", executionKind: "task/review", job: { id: crypto.randomUUID(), taskType: "review-predicate", executionKind: "task/review", phase: "running" } }
    ] }];
    throw new Error("unexpected operation");
  });
  await page.context().route("http://localhost/**", (route) => route.fulfill({ contentType: "text/html", body: `<style>${styles}</style><main class="feature-content feature-page"></main>` }));
  await page.goto("http://localhost/");
  await page.evaluate(`(async () => {
    let path = [];
    const subscribers = new Set();
    const module = await import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(panelSource).toString("base64")}`)});
    const { featureUi } = await import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(uiSource).toString("base64")}`)});
    const advertisedOperations = ${JSON.stringify(descriptors)};
    const browserContext = {
      operations: advertisedOperations,
      invoke: (name, input) => window.executionInvoke(name, input), isCurrent: () => true, ui: featureUi,
      location: {
        get path() { return path; },
        href: (next) => '#/features/execution/' + next.map(encodeURIComponent).join('/'),
        navigate: (next) => { path = [...next]; history.pushState(null, '', '#/features/execution/' + next.map(encodeURIComponent).join('/')); for (const handler of subscribers) handler(path); },
        subscribe: (handler) => { subscribers.add(handler); return () => subscribers.delete(handler); }
      },
      navigation: { canCreateWorkspace: false, hasFeature: () => false, openFeature: async () => ({ status: "unavailable", code: "not-installed", message: "Unavailable" }), openWorkspaceCreate: async () => ({ status: "unavailable", code: "not-installed", message: "Unavailable" }) },
      onNavigate: (handler) => { window.executionNavigate = handler; return () => { delete window.executionNavigate; }; }
    };
    window.remountExecution = (next, operationNames) => {
      browserContext.operations = operationNames ? advertisedOperations.filter(({name}) => operationNames.includes(name)) : advertisedOperations;
      window.disposeExecution?.(); path = [...next]; history.replaceState(null, '', '#/features/execution/' + next.map(encodeURIComponent).join('/'));
      window.disposeExecution = module.mount(document.querySelector("main"), browserContext);
    };
    window.remountExecution([]);
  })()`);
  await page.getByText(/^Could not load jobs: initial jobs unavailable/).waitFor();
  await page.getByRole("button", { name: "Refresh jobs", exact: true }).click();
  await page.getByRole("cell", { name: "first job", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Jobs", exact: true }).getAttribute("href"), "#/features/execution/controllers/first/jobs");
  assert.equal(await page.getByRole("link", { name: "Workers", exact: true }).getAttribute("href"), "#/features/execution/controllers/first/workers");
  assert.equal(await page.getByRole("link", { name: "Launch & ownership", exact: true }).getAttribute("href"), "#/features/execution/controllers/first/launch");
  assert.equal(await page.getByRole("link", { name: "Launch & ownership", exact: true }).evaluate((link) => link.dispatchEvent(new MouseEvent("click", { button: 0, ctrlKey: true, cancelable: true }))), true);
  await page.getByRole("link", { name: "Launch & ownership", exact: true }).click();
  await page.getByText("Execution launch belongs to installed task producers", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: /launch/i }).count(), 0);
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  assert.equal(await page.getByRole("link", { name: "first job", exact: true }).evaluate((link) => link.dispatchEvent(new MouseEvent("click", { button: 0, ctrlKey: true, cancelable: true }))), true);
  await page.getByRole("link", { name: "Workers", exact: true }).click();
  await page.getByRole("heading", { name: "Worker capacity", exact: true }).waitFor();
  await page.getByText("review-predicate / task/review", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "View worker job", exact: true }).count(), 1);
  const workerTable = page.locator('.execution-worker-table');
  await workerTable.waitFor();
  assert.equal(await workerTable.locator('thead th').count(), 7);
  await page.setViewportSize({ width: 375, height: 812 });
  assert.deepEqual(await workerTable.locator('tbody tr').first().locator('td').evaluateAll((cells) => cells.map((cell) => cell.getAttribute('data-label'))), ['Worker', 'Connection', 'Slot', 'State', 'Execution kind', 'Current work', 'Details']);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await workerTable.locator('thead th').last().evaluate((cell) => cell.getBoundingClientRect().width > 60), true);
  await page.getByRole("button", { name: "View worker job", exact: true }).click();
  await page.getByRole("heading", { name: "first detail — finished", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), `#/features/execution/controllers/first/jobs/${job.id}`);
  await page.getByRole("heading", { name: "Results", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Logs", exact: true }).waitFor();
  await page.getByText("This job finished without a guest result or captured logs.", { exact: false }).waitFor();
  await page.getByText("This execution contract does not expose downloadable artifacts", { exact: false }).waitFor();
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
  assert.equal(await page.evaluate(() => location.hash), "#/features/execution/controllers/second/jobs");
  await page.getByRole("cell", { name: "second job", exact: true }).waitFor();
  await page.getByRole("row", { name: /second job sample\/root/ }).getByRole("button", { name: "View job", exact: true }).click();
  await page.getByRole("heading", { name: "second detail — finished", exact: true }).waitFor();
  await page.getByRole("button", { name: "Retry execution", exact: true }).click();
  await page.getByText("Retry execution accepted.", { exact: true }).waitFor();
  const secondRetry = calls.find((call) => call.name === "jobs.retry" && call.input.controllerId === "second");
  assert(secondRetry); assert.notEqual(secondRetry.input.requestId, firstRetries[0]?.input.requestId);
  emptyWorkers = true;
  await page.getByRole("button", { name: "Refresh worker capacity", exact: true }).click();
  await page.getByRole("link", { name: "Workers", exact: true }).click();
  await page.getByText(/^No execution workers configured/).waitFor();
  await page.getByText("Set up execution workers", { exact: true }).click();
  await page.getByText("dim execution worker /absolute/path/to/worker.json", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Execution worker setup guide", exact: true }).getAttribute("href"), "https://github.com/slop-lab/dev-infra-manager/blob/development/docs/guides/ci-runners.md");
  queuedDetail = true;
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
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
  await assertReadOnlyExecutionAuthority(page);
  assert.equal(await page.getByRole("button", { name: "Refresh worker capacity", exact: true }).count(), 0);
  await page.getByRole('link', {name:'Workers',exact:true}).click();
  await page.getByRole('heading', {name:'Capacity access required',exact:true}).waitFor();
  assert.equal(await page.locator('.execution-worker-table').count(),0);
  assert.equal(await page.getByRole("heading", { name: "second detail — finished", exact: true }).count(), 0);
  emptyWorkers = false;
  await assertWorkerOnlyExecutionAccess(page);
  await page.evaluate(`window.remountExecution(["controllers", "first", "jobs", ${JSON.stringify(job.id)}], ["controllers.list", "jobs.list", "jobs.detail"])`);
  await page.getByRole("heading", { name: "first detail — finished", exact: true }).waitFor();
  await assertBrowserRoleExecutionAuthority(page);
  assert(calls.filter((call) => call.name !== "controllers.list").every((call) => typeof call.input.controllerId === "string"));
  const directMutationCount = calls.filter(({name}) => name === 'jobs.cancel' || name === 'jobs.retry').length;
  await page.evaluate(`window.remountExecution(["jobs", ${JSON.stringify(job.id)}], ["jobs.list", "jobs.detail"])`);
  await page.getByRole('heading',{name:'direct detail — finished',exact:true}).waitFor();
  await assertDirectExecutionAuthority(page,'retry','Retry execution');
  queuedDetail = true; await page.getByRole('row',{name:/direct job sample\/root/}).getByRole('button',{name:'View job',exact:true}).click();
  await page.getByRole('heading',{name:'direct detail — queued',exact:true}).waitFor();
  await assertDirectExecutionAuthority(page,'cancel','Cancel execution'); queuedDetail = false;
  assert.equal(calls.filter(({name}) => name === 'jobs.cancel' || name === 'jobs.retry').length,directMutationCount);
  await page.evaluate('window.remountExecution(["controllers", "operator-only", "jobs"])');
  await page.getByLabel('Controller',{exact:true}).waitFor();
  await page.getByLabel("Controller", { exact: true }).selectOption("offline");
  await page.getByText(/^Execution is unavailable on this controller/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Refresh jobs", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Refresh controllers", exact: true }).click();
  await page.getByText(/^Execution is unavailable on this controller/).waitFor();
  assert.equal(await page.getByLabel("Controller", { exact: true }).inputValue(), "offline");
  await page.evaluate(`window.remountExecution(["controllers", "second", "jobs", ${JSON.stringify(job.id)}])`);
  await page.getByLabel("Controller", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Controller", { exact: true }).inputValue(), "second");
  await page.getByRole("heading", { name: "second detail — finished", exact: true }).waitFor();
  await page.getByLabel("Controller", { exact: true }).selectOption("first");
  await page.getByRole("cell", { name: "first job", exact: true }).waitFor();
  for (const [name, width, height] of [["desktop", 1280, 900], ["tablet", 768, 900], ["mobile", 375, 812]] as const) {
    await page.setViewportSize({ width, height });
    for (const section of ["Jobs", "Workers", "Launch & ownership"] as const) {
      await page.getByRole("link", { name: section, exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
      if (evidence) await page.screenshot({ path: `${evidence}/execution-${section.toLowerCase().replaceAll(" ", "-").replace("&", "and")}-${name}.png`, fullPage: true });
    }
  }
  assert.equal(await page.evaluate(`window.disposeExecution(); typeof window.executionNavigate`), "undefined");
  assert.deepEqual(errors, []);
  process.stdout.write("Execution controller discovery, permissions, retry scopes and stale-response isolation passed.\n");
} finally { releaseDetail(); await browser.close(); }
