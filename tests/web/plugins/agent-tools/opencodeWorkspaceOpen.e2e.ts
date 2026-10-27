import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { clientSummary, createDimWebFixture, type DimWebFixture, type StorageTarget } from "./opencodeDimWebFixture.js";
import { createOpenCodeRuntimeFixture } from "./opencodeRuntimeFixture.js";
import { captureLinkState } from "./opencodeEvidence.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");

async function login(page: Page, fixture: DimWebFixture): Promise<void> {
  await page.goto(fixture.origin);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".workspace-row").first().waitFor({state:'attached'});
}

function workspaceRow(page: Page, host: string): Locator {
  return page.locator(".workspace-host").filter({ has: page.getByRole("heading", { name: host, exact: true }) })
    .locator(".workspace-row").filter({ has: page.getByRole("heading", { name: "development", exact: true }) });
}

async function revealTools(row: Locator): Promise<void> {
  const href = await row.getByRole('heading', {name:'development',exact:true}).getByRole('link').getAttribute('href');
  assert(href);
  await row.page().locator(`.workspace-list-item a[href="${href}"]`).click();
  await row.getByRole('link',{name:'Tools',exact:true}).click();
  await row.getByText("opencode: 1.18.31", { exact: true }).waitFor();
}

async function openClient(row: Locator, page: Page): Promise<Page> {
  const popup = page.waitForEvent("popup");
  await row.getByRole("link", { name: "Open OpenCode Web", exact: true }).click();
  const client = await popup;
  client.setDefaultTimeout(20_000);
  return client;
}

async function authenticate(client: Page, username: string, password: string, wrongFirst = false): Promise<void> {
  await client.getByText("Authentication required", { exact: true }).waitFor();
  await captureLinkState(client, "authentication");
  const url = client.getByLabel(/^(URL|Server address)$/);
  assert.equal(await url.isEditable(), false);
  assert.equal(new URL(await url.inputValue()).username, "");
  if (wrongFirst) {
    const beforeWrong = await clientSummary(client, []);
    await client.getByLabel(/^Username(?: \(optional\))?$/).fill(username);
    await client.getByLabel(/^Password(?: \(optional\))?$/).fill(`${password}-wrong`);
    const rejected = client.waitForResponse((response) => new URL(response.url()).pathname === "/global/health" && response.status() === 401);
    await client.getByRole("button", { name: "Add server", exact: true }).click();
    await rejected;
    await client.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Add server" && !button.disabled));
    assert.equal((await clientSummary(client, [])).serverCount, beforeWrong.serverCount);
    await client.getByText("Authentication required", { exact: true }).waitFor();
  }
  await client.getByLabel(/^Username(?: \(optional\))?$/).fill(username);
  await client.getByLabel(/^Password(?: \(optional\))?$/).fill(password);
  const submit = client.getByRole("button", { name: /^(Add server|Save)$/ });
  await submit.click();
  await client.getByText("Authentication required", { exact: true }).waitFor({ state: "detached" });
  await client.getByText("Opening workspace…", { exact: true }).waitFor({ state: "detached" });
}

async function assertOpened(client: Page, target: StorageTarget): Promise<void> {
  await client.waitForFunction(({ endpoint, directory }) => {
    const tabs: unknown = JSON.parse(localStorage.getItem("opencode.window.browser.dat:tabs") ?? "[]");
    if (!Array.isArray(tabs)) return false;
    return tabs.some((tab: unknown) => !!tab && typeof tab === "object" && "server" in tab && "directory" in tab && "draftID" in tab
      && tab.server === endpoint && tab.directory === directory && typeof tab.draftID === "string"
      && new URLSearchParams(location.hash.split("?")[1]).get("draftId") === tab.draftID);
  }, { endpoint: target.endpoint, directory: target.directory });
  await client.getByText(basename(target.directory), { exact: true }).filter({ visible: true }).first().waitFor();
  const summary = await clientSummary(client, [target]);
  assert.equal(summary.targets[0]?.projectPresent, true);
  assert.equal(summary.targets[0]?.credentialsPreserved, true);
  assert.equal(summary.targets[0]?.draftCount, 1);
  assert.equal(summary.targets[0]?.draftSelected, true);
  assert.equal(summary.targets[0]?.defaultSelected, true);
  assert.equal(directoryRequests.has(`${target.endpoint}\n${target.directory}`), true, "real backend receives the exact guest directory");
}

function assertCredentialFreeUrls(pages: readonly Page[], secrets: readonly string[]): void {
  for (const page of pages) {
    const url = page.url();
    for (const secret of secrets) assert.equal(url.includes(secret), false);
    assert.equal(new URL(url).username, "");
    assert.equal(new URL(url).password, "");
  }
}

const runtime = await createOpenCodeRuntimeFixture();
const firstTarget = { endpoint: runtime.first.endpoint, username: runtime.first.username, password: runtime.first.password, directory: "/workspace/main" };
const secondTarget = { endpoint: runtime.second.endpoint, username: runtime.second.username, password: runtime.second.password, directory: "/workspace" };
const targets = [firstTarget, secondTarget];
const preservedSession = await runtime.second.createSession(secondTarget.directory);
const firstId = randomUUID();
const secondId = randomUUID();
const dim = await createDimWebFixture([
  { selector: "alpha", id: firstId, endpoint: runtime.first.endpoint, directory: "/workspace/main" },
  { selector: "beta", id: secondId, endpoint: runtime.second.endpoint, directory: "/workspace" },
]);
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
await context.grantPermissions(["local-network-access"], { origin: "https://slop-lab.github.io" });
await runtime.routePages(context);
const page = await context.newPage();
page.setDefaultTimeout(20_000);
let pageErrorCount = 0;
const healthStatuses: number[] = [];
const healthAuthentication: Promise<boolean>[] = [];
const directoryRequests = new Set<string>();
let completedScenarios = 0;
let currentStep = "login";
let activeClient: Page | undefined;
let credentialUrlCount = 0;
context.on("page", (opened) => opened.on("pageerror", () => { pageErrorCount += 1; }));
context.on("response", (response) => {
  if (new URL(response.url()).pathname === "/global/health") {
    healthStatuses.push(response.status());
    healthAuthentication.push(response.request().headerValue("authorization").then(Boolean));
  }
});
context.on("request", async (request) => {
  const url = new URL(request.url());
  if (url.username || url.password || [runtime.first.username, runtime.first.password, runtime.second.username, runtime.second.password].some((secret) => url.href.includes(secret))) credentialUrlCount++;
  if (![runtime.first.endpoint, runtime.second.endpoint].includes(url.origin)) return;
  const directory = url.searchParams.get("directory");
  const headerDirectory = directory === null ? await request.headerValue("x-opencode-directory") : null;
  if (directory !== null) directoryRequests.add(`${url.origin}\n${directory}`);
  else if (headerDirectory) directoryRequests.add(`${url.origin}\n${decodeURIComponent(headerDirectory)}`);
});

try {
  await login(page, dim);
  const alpha = workspaceRow(page, "alpha");
  const beta = workspaceRow(page, "beta");
  await revealTools(alpha);
  await revealTools(beta);

  // Given two same-named workspaces, when beta opens, then ordinary /workspace is registered through the real client.
  const betaClient = await openClient(beta, page);
  activeClient = betaClient; currentStep = "authenticate-ordinary";
  await authenticate(betaClient, runtime.second.username, runtime.second.password);
  currentStep = "assert-ordinary";
  await assertOpened(betaClient, secondTarget);
  completedScenarios++;

  // Given an existing unrelated registration and draft, when alpha opens, then wrong auth recovers and the exact managed directory opens.
  const alphaClient = await openClient(alpha, page);
  activeClient = alphaClient; currentStep = "authenticate-managed";
  await authenticate(alphaClient, runtime.first.username, runtime.first.password, true);
  await assertOpened(alphaClient, firstTarget);
  await captureLinkState(alphaClient, "project");
  const registered = await clientSummary(alphaClient, targets);
  assert.equal(registered.serverCount, 2);
  assert.equal(registered.uniqueEndpointCount, 2);
  assert.equal(registered.targets.every((target) => target.registrationCount === 1 && target.projectCount === 1 && target.projectPresent && target.credentialsPreserved && target.draftCount === 1), true);
  assert.equal(await runtime.second.sessionPreserved(secondTarget.directory, preservedSession), true);
  completedScenarios++;

  // Given saved exact-server credentials, when the DIM link repeats and reloads, then no duplicate auth or draft appears.
  const repeated = await openClient(alpha, page);
  await repeated.getByText("Authentication required", { exact: true }).waitFor({ state: "detached" });
  await repeated.getByText("Opening workspace…", { exact: true }).waitFor({ state: "detached" });
  await assertOpened(repeated, firstTarget);
  const repeatedStorage = await clientSummary(repeated, targets);
  assert.deepEqual(repeatedStorage, registered);
  await repeated.reload();
  await assertOpened(repeated, firstTarget);
  assert.deepEqual(await clientSummary(repeated, targets), registered);
  await repeated.close();
  completedScenarios++;

  // Given a second selected server, when it reloads after alpha activity, then its server and ordinary project remain selected.
  const selectedBeta = await openClient(beta, page);
  await assertOpened(selectedBeta, secondTarget);
  await selectedBeta.reload();
  await assertOpened(selectedBeta, secondTarget);
  assert.equal(await runtime.second.sessionPreserved(secondTarget.directory, preservedSession), true);
  await selectedBeta.close();
  completedScenarios++;

  // Given an owned space/Unicode directory, when refreshed and opened, then the exact directory reaches OpenCode.
  await dim.setDirectory("alpha", runtime.unicodeDirectory);
  await alpha.getByRole("button", { name: "Refresh status", exact: true }).click();
  await alpha.getByText("Refresh status completed.", { exact: true }).waitFor();
  const unicodeClient = await openClient(alpha, page);
  await unicodeClient.getByText("Opening workspace…", { exact: true }).waitFor({ state: "detached" });
  await assertOpened(unicodeClient, { ...firstTarget, directory: runtime.unicodeDirectory });
  await unicodeClient.close();
  completedScenarios++;

  // Given a temporarily unavailable backend, when Retry follows recovery, then the existing registration opens without credential transfer.
  await runtime.first.stop();
  const unavailable = await openClient(alpha, page);
  activeClient = unavailable; currentStep = "recover-unavailable";
  await unavailable.getByText("The OpenCode server is unavailable.", { exact: true }).waitFor();
  await captureLinkState(unavailable, "unavailable");
  await runtime.first.start();
  await unavailable.getByRole("button", { name: "Retry", exact: true }).click();
  await unavailable.getByText("Opening workspace…", { exact: true }).waitFor({ state: "detached" });
  await assertOpened(unavailable, { ...firstTarget, directory: runtime.unicodeDirectory });
  assert.equal(await runtime.second.sessionPreserved(secondTarget.directory, preservedSession), true);
  completedScenarios++;

  // Given no usable approved route, when status refreshes, then setup remains available and no Open link is offered.
  await dim.setEndpoint("beta", null);
  await beta.getByRole("button", { name: "Refresh status", exact: true }).click();
  await beta.getByText("Refresh status completed.", { exact: true }).waitFor();
  assert.equal(await beta.getByRole("link", { name: "Open OpenCode Web", exact: true }).count(), 0);
  assert.equal(await beta.getByRole("button", { name: "Configure external access", exact: true }).count(), 1);
  completedScenarios++;

  // Given hostile launch hashes, when the actual pinned route parses them, then storage and DIM invocations remain unchanged.
  const beforeInvalidStorage = await clientSummary(unavailable, targets);
  const beforeInvalidCalls = (await dim.invocations()).length;
  const invalidHashes = [
    "#/dim/open?server=javascript%3Aalert(1)&directory=%2Fworkspace",
    "#/dim/open?server=https%3A%2F%2Fu%3Ap%40example.test&directory=%2Fworkspace",
    "#/dim/open?server=https%3A%2F%2Fexample.test%3Fauth_token%3Dx&directory=%2Fworkspace",
    "#/dim/open?server=https%3A%2F%2Fa.test&server=https%3A%2F%2Fb.test&directory=%2Fworkspace",
    "#/dim/open?server=https%3A%2F%2Fa.test&directory=%2Fetc",
    "#/dim/open?server=https%3A%2F%2Fa.test&directory=%2Fworkspace%2F.",
    "#/dim/open?server=https%3A%2F%2Fa.test&directory=%2Fworkspace%2F..%2Fprivate",
    "#/dim/open?server=https%3A%2F%2Fa.test&directory=%2Fworkspace%2Fa%5Cb",
    "#/dim/open?server=https%3A%2F%2Fa.test%2F%252e%252e%2Fprivate&directory=%2Fworkspace",
    "#/dim/open?server=https%3A%2F%2Fa.test%2F%5Cother&directory=%2Fworkspace",
    "#/dim/open?server=https%3A%2F%2Fa.test&directory=%2Fworkspace&auth_token=fixture-invalid",
    "?auth_token=fixture-invalid#/dim/open?server=https%3A%2F%2Fa.test&directory=%2Fworkspace",
  ] as const;
  const invalid = await context.newPage();
  for (const hash of invalidHashes) {
    await invalid.goto(`https://slop-lab.github.io/dev-infra-manager/opencode-web/${hash}`);
    await invalid.getByText("This workspace link is invalid.", { exact: true }).waitFor();
    assert.deepEqual(await clientSummary(invalid, targets), beforeInvalidStorage);
  }
  assert.equal((await dim.invocations()).length, beforeInvalidCalls);
  assert.equal(await runtime.second.sessionPreserved(secondTarget.directory, preservedSession), true);
  const preserved = await clientSummary(invalid, targets);
  assert.equal(preserved.serverCount, 2);
  assert.equal(preserved.uniqueEndpointCount, 2);
  assert.equal(preserved.draftCount, 3);
  assert.deepEqual(preserved.targets.map((target) => target.projectCount), [2, 1]);
  assert.equal(preserved.targets.every((target) => target.projectPresent && target.credentialsPreserved && target.draftCount === 1), true);
  completedScenarios++;

  assertCredentialFreeUrls(context.pages(), [runtime.first.password, runtime.second.password, runtime.first.username, runtime.second.username]);
  assert.equal(pageErrorCount, 0);
  assert.equal(credentialUrlCount, 0);
  if (process.env.DIM_WEB_EVIDENCE) {
    await mkdir(process.env.DIM_WEB_EVIDENCE, { recursive: true, mode: 0o700 });
    await writeFile(join(process.env.DIM_WEB_EVIDENCE, "workspace-open-result.json"), JSON.stringify({ result: "passed", completedScenarios, invalidBoundaries: invalidHashes.length, backendCount: 2, preservedRegistrations: preserved.serverCount, sessionPreserved: true, pageErrorCount, credentialUrlCount, clientVersion: "1.18.31" }, null, 2), { mode: 0o600 });
  }
  process.stdout.write(`OpenCode workspace link E2E passed: 8 scenarios, ${invalidHashes.length} invalid boundaries, 2 real backends, 2 preserved registrations.\n`);
} catch (error) {
  const evidence = process.env.DIM_WEB_EVIDENCE;
  const [stored, view] = await Promise.allSettled([activeClient ? clientSummary(activeClient, targets) : undefined,
    activeClient?.evaluate(() => ({ auth: document.body.innerText.includes("Authentication required"), opening: document.body.innerText.includes("Opening workspace…"), failed: document.body.innerText.includes("The workspace could not be opened."), route: location.hash.startsWith("#/dim/open") ? "launch" : location.hash.startsWith("#/new-session") ? "draft" : "other" }))]);
  const summary = { result: "failed", currentStep, failureKind: error instanceof Error ? error.name : "unknown", storeShape: error instanceof Error ? error.message.match(/Invalid client store shape: (?:server|connection-http|connection|projects|tab|recent|project)\b/)?.[0] : undefined, stored: stored.status === "fulfilled" ? stored.value : undefined, view: view.status === "fulfilled" ? view.value : undefined,
    healthStatuses, authHeaderPresent: await Promise.all(healthAuthentication), pageErrorCount, credentialUrlCount, completedScenarios, backendCount: 2, clientVersion: "1.18.31" };
  if (evidence) {
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    await writeFile(join(evidence, "workspace-open-result.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  }
  process.stderr.write(`Bounded cross-client evidence: ${JSON.stringify(summary)}\n`);
  if (error instanceof Error) throw new Error("Cross-client scenario failed; inspect the fixed-field private result summary");
  throw new Error("Cross-client scenario failed with a non-error value");
} finally {
  await context.close();
  await browser.close();
  await dim.close();
  await runtime.close();
}
