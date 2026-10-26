import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page, type Route } from "playwright-core";
import { createOperationsBrowserFixture } from "./operationsBrowserFixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");

const evidenceDirectory = process.env.DIM_WEB_EVIDENCE
  ?? await mkdtemp(join(tmpdir(), "dim-web-recovery-evidence-"));
await mkdir(evidenceDirectory, { recursive: true });

const fixture = await createOperationsBrowserFixture();
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));

async function signIn(target: Page) {
  await target.goto(fixture.origin);
  await target.getByLabel("Username").fill(fixture.username);
  await target.getByLabel("Password").fill(fixture.password);
  await target.getByRole("button", { name: "Sign in" }).click();
  await target.getByText("Workspaces refreshed.", { exact: true }).waitFor();
}

async function abortCommittedMutation(route: Route) {
  await route.fetch();
  await route.abort("connectionreset");
}

try {
  await signIn(page);
  const development = page.locator(".workspace-row").filter({ has: page.getByRole("heading", { name: "development", exact: true }) });
  await fixture.stopRuntime();
  await page.getByRole("button", { name: "Refresh workspaces on devbox", exact: true }).click();
  await development.getByRole("button", { name: "start development", exact: true }).waitFor();
  await page.getByLabel("Filter workspaces by state on devbox", { exact: true }).selectOption("stopped");
  assert.equal(await development.isVisible(), true);
  await development.getByRole("button", { name: "start development", exact: true }).click();
  await development.getByRole("button", { name: "stop development", exact: true }).waitFor({state:"hidden"});
  await page.getByLabel("Filter workspaces by state on devbox", { exact: true }).selectOption("all");
  await development.getByRole("button", { name: "stop development", exact: true }).waitFor();
  await development.getByText("Settings for development", { exact: true }).click();
  await development.getByText(/resource change.*interrupting running processes and attached sessions.*keeping workspace data/i).waitFor();
  await development.getByText(/recreate replaces the runtime.*interrupting running processes and attached sessions.*keeping checkout, home and nested Docker data/i).waitFor();
  await development.getByLabel("CPUs for development", { exact: true }).fill("0.75");
  await development.getByRole("button", { name: "Reset resource changes for development", exact: true }).click();
  assert.equal(await development.getByLabel("CPUs for development", { exact: true }).inputValue(), "1");
  await development.getByLabel("CPUs for development", { exact: true }).fill("0.75");

  const search = page.getByLabel("Filter workspaces by name on devbox", { exact: true });
  const state = page.getByLabel("Filter workspaces by state on devbox", { exact: true });
  await search.fill("missing");
  await page.getByText("No workspaces match these filters.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Clear workspace filters on devbox", exact: true }).click();
  assert.equal(await development.isVisible(), true);
  assert.equal(await development.getByLabel("CPUs for development", { exact: true }).inputValue(), "0.75");
  await state.selectOption("error");
  assert.equal(await development.isVisible(), false);
  await state.selectOption("all");

  let releaseStale: (() => void) | undefined;
  let markStaleStarted: (() => void) | undefined;
  const staleStarted = new Promise<void>((resolve) => { markStaleStarted = resolve; });
  const staleRelease = new Promise<void>((resolve) => { releaseStale = resolve; });
  await page.route("**/v1/operations/hosts/devbox/workspaces", async (route) => {
    const stale = await route.fetch();
    markStaleStarted?.();
    await staleRelease;
    await route.fulfill({ response: stale });
  }, { times: 1 });
  await page.getByRole("button", { name: "Refresh workspaces on devbox", exact: true }).click();
  await staleStarted;
  await development.getByRole("button", { name: "stop development", exact: true }).click();
  releaseStale?.();
  await development.getByRole("button", { name: "start development", exact: true }).waitFor();
  assert.equal((await fixture.workspace()).phase, "stopped");

  const actionsBeforeLostStart = (await fixture.actions()).filter((action) => action === "start").length;
  await page.route("**/v1/operations/hosts/devbox/workspaces", abortCommittedMutation, { times: 1 });
  await development.getByRole("button", { name: "start development", exact: true }).click();
  await development.getByText(/outcome is unknown/i).waitFor();
  assert.equal(await development.getByRole("button", { name: "start development", exact: true }).isDisabled(), true);
  assert.equal((await fixture.actions()).filter((action) => action === "start").length, actionsBeforeLostStart + 1);
  await development.getByRole("button", { name: "Check current state for development", exact: true }).click();
  await development.getByRole("button", { name: "restart development", exact: true }).waitFor();
  assert.equal((await fixture.actions()).filter((action) => action === "start").length, actionsBeforeLostStart + 1);
  assert.equal(await development.getByLabel("CPUs for development", { exact: true }).inputValue(), "0.75");
  await development.getByText("Unsaved resource changes.", { exact: true }).waitFor();

  await development.getByLabel("Memory for development", { exact: true }).fill("unlimited");
  await fixture.failNextList();
  await development.getByRole("button", { name: "Apply resources for development", exact: true }).click();
  await development.getByText(/accepted.*current state/i).waitFor();
  assert.equal(await development.getByRole("button", { name: "Apply resources for development", exact: true }).isDisabled(), true);
  await development.getByRole("button", { name: "Check current state for development", exact: true }).click();
  await development.getByText(/current state checked/i).waitFor();
  assert.equal(await development.getByLabel("Memory for development", { exact: true }).inputValue(), "unlimited");
  await development.getByText("No unsaved resource changes.", { exact: true }).waitFor();

  // Given an edited resource draft whose mutation response is lost before the fake host receives it.
  const pids = development.getByLabel("PIDs for development", { exact: true });
  await pids.fill("768");
  await page.route("**/v1/operations/hosts/devbox/workspaces", (route) => route.abort("connectionreset"), { times: 1 });
  // When the operator checks the unchanged authoritative state after the unknown outcome.
  await development.getByRole("button", { name: "Apply resources for development", exact: true }).click();
  await development.getByText(/outcome is unknown/i).waitFor();
  assert.equal((await fixture.workspace()).resources.pidsLimit, "512");
  await development.getByRole("button", { name: "Check current state for development", exact: true }).click();
  await development.getByText(/current state checked/i).waitFor();
  // Then the unmatched draft remains available for an explicit retry instead of becoming false success.
  assert.equal(await pids.inputValue(), "768");
  assert.equal(await development.getByRole("button", { name: "Apply resources for development", exact: true }).isEnabled(), true);
  await development.getByText("Unsaved resource changes.", { exact: true }).waitFor();

  await page.getByRole("button", { name: "New workspace on devbox", exact: true }).click();
  const create = page.getByRole("form", { name: "New workspace on devbox", exact: true });
  await create.getByLabel("Git URL or dim://PROJECT on devbox", { exact: true }).fill("https://example.test/recovered.git");
  await create.getByLabel("Workspace name on devbox", { exact: true }).fill("response-lost");
  const createsBefore = (await fixture.actions()).filter((action) => action === "create").length;
  await page.route("**/v1/operations/hosts/devbox/workspaces/create", abortCommittedMutation, { times: 1 });
  await create.getByRole("button", { name: "Create workspace on devbox", exact: true }).click();
  await create.getByText(/outcome is unknown/i).waitFor();
  assert.equal(await create.getByRole("button", { name: "Create workspace on devbox", exact: true }).isDisabled(), true);
  await create.dispatchEvent("submit");
  assert.equal((await fixture.actions()).filter((action) => action === "create").length, createsBefore + 1);
  await create.getByRole("button", { name: "Check current state for response-lost", exact: true }).click();
  await page.getByRole("heading", { name: "response-lost", exact: true }).waitFor();
  assert.match(await create.innerText(), /already exists in the current host state/i);
  assert.doesNotMatch(await create.innerText(), /created by this attempt/i);
  assert.equal((await fixture.actions()).filter((action) => action === "create").length, createsBefore + 1);
  assert(await fixture.workspaceNamed("response-lost"));

  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: `${evidenceDirectory}/workspace-operations-${width}.png` });
  }
  assert.deepEqual(errors, []);
  console.log("workspace-operations-recovery: filters, refresh ordering, mutation reconciliation, resource reset and responsive layout PASS");
} finally {
  await browser.close();
  await fixture.close();
  if (!process.env.DIM_WEB_EVIDENCE) await rm(evidenceDirectory, { recursive: true, force: true });
}
