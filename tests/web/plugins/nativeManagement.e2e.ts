import assert from "node:assert/strict";
import { chromium, type APIResponse } from "playwright-core";
import { createNativeManagementBrowserFixture } from "./nativeManagementBrowserFixture.js";
const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const screenshotPath = process.env.DIM_WEB_SCREENSHOT;
const fixture = await createNativeManagementBrowserFixture({ existingProjectAttachment: true }), browser = await chromium.launch({ executablePath, headless: true }), page = await browser.newPage();
page.setDefaultTimeout(20_000);
const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
let imports = 0; page.on("request", (request) => { if (request.url().endsWith("/operations/repositories.import")) imports++; });
async function login(username: string) {
  await page.goto(fixture.origin); await page.getByLabel("Username", { exact: true }).fill(username); await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("link", { name: "Git review", exact: true }).click();
}
try {
  await login(fixture.username);
  const git = page.locator(".feature-page").filter({ has: page.getByRole("heading", { name: "Git review", exact: true, level: 1 }) });
  const attachment = git.getByRole("form", { name: "Attach existing managed project", exact: true });
  async function prepareAttachment(name: string) {
    const disclosure = git.getByText("Attach existing project", { exact: true });
    if (!await attachment.isVisible()) await disclosure.click();
    await attachment.getByRole("button", { name: "Discover available projects", exact: true }).click();
    await attachment.getByLabel("Available project", { exact: true }).selectOption("project-a");
    await attachment.getByRole("button", { name: "Inspect repositories", exact: true }).click();
    await attachment.getByText("Choose the configuration and default working repositories explicitly. They may be the same.", { exact: true }).waitFor();
    await attachment.getByLabel("Configuration repository", { exact: true }).selectOption("public");
    await attachment.getByLabel("Default working repository", { exact: true }).selectOption("private");
    await attachment.getByLabel("Local project name (optional)", { exact: true }).fill(name);
  }
  await prepareAttachment("stale-response");
  let releaseResponse = () => {}, responseSeen = () => {}, responseFinished = () => {};
  const release = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const seen = new Promise<void>((resolve) => { responseSeen = resolve; });
  const finished = new Promise<void>((resolve) => { responseFinished = resolve; });
  await page.route("**/v1/extensions/native-git/operations/projects.attach", async (route) => {
    responseSeen(); await release;
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"projectId":"project-a","repositoryCount":2}' });
    responseFinished();
  });
  await attachment.getByRole("button", { name: "Attach project", exact: true }).click();
  await seen;
  await git.getByLabel("Git connection", { exact: true }).selectOption("otherbox");
  releaseResponse(); await finished;
  assert.equal(await git.getByLabel("Git connection", { exact: true }).inputValue(), "otherbox");
  await page.unroute("**/v1/extensions/native-git/operations/projects.attach");
  await git.getByLabel("Git connection", { exact: true }).selectOption("devbox");
  await prepareAttachment("taken");
  await git.getByRole("button", { name: "Refresh projects", exact: true }).click();
  assert.equal(await attachment.getByLabel("Available project", { exact: true }).inputValue(), "project-a");
  assert.equal(await attachment.getByLabel("Configuration repository", { exact: true }).inputValue(), "public");
  assert.equal(await attachment.getByLabel("Default working repository", { exact: true }).inputValue(), "private");
  assert.equal(await attachment.getByLabel("Local project name (optional)", { exact: true }).inputValue(), "taken");
  await attachment.getByRole("button", { name: "Attach project", exact: true }).click();
  await attachment.getByText(/Existing local state was not replaced/).waitFor();
  assert.equal(await attachment.getByLabel("Configuration repository", { exact: true }).inputValue(), "public");
  assert.equal(await attachment.getByLabel("Default working repository", { exact: true }).inputValue(), "private");
  await attachment.getByLabel("Local project name (optional)", { exact: true }).fill("attached-copy");
  // Keep a valid attachment pending beyond the ordinary 35-second feature deadline.
  await page.route("**/v1/extensions/native-git/operations/projects.attach", async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 36_000));
    await route.fulfill({ response });
  });
  await attachment.getByRole("button", { name: "Attach project", exact: true }).click();
  await page.waitForFunction(() => { const input = document.querySelector('select[aria-label="Project"]'); return input instanceof HTMLSelectElement && input.value === "project-a"; }, undefined, { timeout: 60_000 });
  await page.unroute("**/v1/extensions/native-git/operations/projects.attach");
  assert.equal(await git.getByLabel("Repository", { exact: true }).inputValue(), "private");
  const attached = await fixture.store.read("attached-copy", fixture.managed.connection.hostId);
  assert(attached); assert.equal(attached.phase, "ready"); assert.equal(attached.configurationRepositoryId, "public"); assert.equal(attached.defaultWorkingRepositoryId, "private");
  if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
  await git.getByRole("button", { name: "Create managed workspace", exact: true }).click();
  const workspaceDraft = page.getByRole("form", { name: "New workspace on devbox", exact: true });
  await workspaceDraft.getByLabel("Git URL or dim://PROJECT on devbox", { exact: true }).waitFor();
  assert.equal(await workspaceDraft.getByLabel("Git URL or dim://PROJECT on devbox", { exact: true }).inputValue(), "dim://attached-copy");
  assert.equal(await workspaceDraft.getByLabel("Managed repositories (comma separated, optional) on devbox", { exact: true }).inputValue(), "private");
  assert.equal(await workspaceDraft.getByLabel("Managed working repository (optional) on devbox", { exact: true }).inputValue(), "private");
  await workspaceDraft.getByRole("button", { name: "Cancel new workspace on devbox", exact: true }).click();
  await page.getByRole("link", { name: "Git review", exact: true }).click();
  await git.getByText("New project", { exact: true }).click();
  const create = git.getByRole("form", { name: "New managed project", exact: true });
  await create.getByLabel("New project ID", { exact: true }).fill("browser-created"); await create.getByRole("button", { name: "Create project", exact: true }).click();
  await create.getByText("Project browser-created created. Import its first repository to begin developing.", { exact: true }).waitFor();
  await page.waitForFunction(() => { const input = document.querySelector('select[aria-label="Project"]'); return input instanceof HTMLSelectElement && input.value === "browser-created"; });
  assert.equal(await git.getByLabel("Project", { exact: true }).inputValue(), "browser-created");
  assert.equal(await create.getByRole("button", { name: "Create project", exact: true }).isDisabled(), true);
  await git.getByText("Import repository", { exact: true }).first().click();
  const importing = git.getByRole("form", { name: "Import public Git repository", exact: true });
  await importing.getByLabel("New repository ID", { exact: true }).fill("public");
  await importing.getByLabel("Public HTTPS Git URL", { exact: true }).fill("https://github.com/mjy9088/missing.git");
  await importing.getByRole("button", { name: "Import repository", exact: true }).click();
  await importing.getByText(/Could not import browser-created\/public:/).waitFor();
  assert.equal(await importing.getByLabel("Public HTTPS Git URL", { exact: true }).inputValue(), "https://github.com/mjy9088/missing.git");
  assert.equal(await importing.getByLabel("New repository ID", { exact: true }).inputValue(), "public");
  let failCatalog = true;
  await page.route("**/v1/extensions/native-git/operations/projects.list", async (route) => {
    if (failCatalog) { failCatalog = false; await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture read unavailable"}' }); }
    else await route.continue();
  });
  await importing.getByLabel("Public HTTPS Git URL", { exact: true }).fill("https://github.com/mjy9088/codyssey-public.git");
  await importing.getByRole("button", { name: "Import repository", exact: true }).click();
  await importing.getByText(/browser-created\/public imported at .*Latest project catalog could not refresh/).waitFor();
  assert.equal(await importing.getByRole("button", { name: "Import repository", exact: true }).isDisabled(), true);
  const acceptedImports = imports; await importing.dispatchEvent("submit"); assert.equal(imports, acceptedImports);
  const first = await fixture.store.read("browser-created", fixture.managed.connection.hostId);
  assert(first); assert.equal(first.phase, "ready"); assert.equal(first.defaultWorkingRepositoryId, "public"); assert.equal(first.configurationRepositoryId, "public");
  await page.unroute("**/v1/extensions/native-git/operations/projects.list");
  await git.getByRole("button", { name: "Refresh projects", exact: true }).click();
  await git.getByLabel("Repository", { exact: true }).selectOption("public");
  await importing.getByLabel("New repository ID", { exact: true }).fill("private");
  await importing.getByLabel("Public HTTPS Git URL", { exact: true }).fill("https://github.com/mjy9088/codyssey-private.git");
  await importing.getByLabel("Branch (optional)", { exact: true }).fill("main");
  await importing.getByRole("button", { name: "Import repository", exact: true }).click();
  await importing.getByText(/browser-created\/private imported at/).waitFor();
  await page.waitForFunction(() => { const input = document.querySelector('select[aria-label="Repository"]'); return input instanceof HTMLSelectElement && input.value === "private"; });
  const record = await fixture.store.read("browser-created", fixture.managed.connection.hostId);
  assert(record); assert.deepEqual(Object.keys(record.repositories).sort(), ["private", "public"]); assert.equal(record.defaultWorkingRepositoryId, "public");
  assert.notEqual(record.repositories.public?.commit, record.repositories.private?.commit);
  assert.equal(imports, acceptedImports + 1);
  assert.equal((await git.innerText()).includes(fixture.managed.root), false);
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login("readonly");
  assert.equal(await git.getByRole("form", { name: "New managed project", exact: true }).isHidden(), true);
  assert.equal(await git.getByRole("form", { name: "Import public Git repository", exact: true }).isHidden(), true);
  const session = await page.request.get(fixture.origin + "/v1/session"), body: unknown = await session.json();
  assert(typeof body === "object" && body !== null && "csrfToken" in body && typeof body.csrfToken === "string");
  assert.equal(await git.getByRole("form", { name: "Attach existing managed project", exact: true }).isHidden(), true);
  for (const [name, input] of [["projects.create", { projectId: "unauthorized" }], ["repositories.import", { projectId: "browser-created", repositoryId: "foreign", url: "https://github.com/mjy9088/codyssey-public.git" }], ["projects.attach", { projectId: "project-a", name: "viewer-attach", configurationRepositoryId: "public", defaultWorkingRepositoryId: "private" }]] as const) {
    const denied: APIResponse = await page.request.post(`${fixture.origin}/v1/extensions/native-git/operations/${name}`, { headers: { Origin: fixture.origin, "x-dim-csrf": body.csrfToken }, data: { controllerId: "devbox", ...input } }); assert.equal(denied.status(), 403);
  }
  assert.equal(await fixture.store.read("unauthorized", fixture.managed.connection.hostId), undefined);
  assert.deepEqual(errors, []); process.stdout.write("Native Git existing-project attachment, project creation and two public repository import browser workflows passed.\n");
} catch (error) { if (errors.length) process.stderr.write(`Browser errors: ${errors.join("; ")}\n`); throw error; }
finally { await browser.close(); await fixture.close(); }
