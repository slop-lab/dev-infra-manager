import assert from "node:assert/strict";
import { chromium, type APIResponse } from "playwright-core";
import { createNativeManagementBrowserFixture } from "./nativeManagementBrowserFixture.js";
const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const fixture = await createNativeManagementBrowserFixture(), browser = await chromium.launch({ executablePath, headless: true }), page = await browser.newPage();
page.setDefaultTimeout(20_000);
const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
let imports = 0; page.on("request", (request) => { if (request.url().endsWith("/operations/repositories.import")) imports++; });
async function login(username: string) {
  await page.goto(fixture.origin); await page.getByLabel("Username", { exact: true }).fill(username); await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("button", { name: "Git review", exact: true }).click();
}
try {
  await login(fixture.username);
  const git = page.locator(".feature-page").filter({ has: page.getByRole("heading", { name: "Git review", exact: true, level: 1 }) });
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
  const first = await fixture.managed.store.read("browser-created", fixture.managed.connection.hostId);
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
  const record = await fixture.managed.store.read("browser-created", fixture.managed.connection.hostId);
  assert(record); assert.deepEqual(Object.keys(record.repositories).sort(), ["private", "public"]); assert.equal(record.defaultWorkingRepositoryId, "public");
  assert.notEqual(record.repositories.public?.commit, record.repositories.private?.commit);
  assert.equal(imports, acceptedImports + 1);
  assert.equal((await git.innerText()).includes(fixture.managed.root), false);
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await login("readonly");
  assert.equal(await git.getByRole("form", { name: "New managed project", exact: true }).isHidden(), true);
  assert.equal(await git.getByRole("form", { name: "Import public Git repository", exact: true }).isHidden(), true);
  const session = await page.request.get(fixture.origin + "/v1/session"), body: unknown = await session.json();
  assert(typeof body === "object" && body !== null && "csrfToken" in body && typeof body.csrfToken === "string");
  for (const [name, input] of [["projects.create", { projectId: "unauthorized" }], ["repositories.import", { projectId: "browser-created", repositoryId: "foreign", url: "https://github.com/mjy9088/codyssey-public.git" }]] as const) {
    const denied: APIResponse = await page.request.post(`${fixture.origin}/v1/extensions/native-git/operations/${name}`, { headers: { Origin: fixture.origin, "x-dim-csrf": body.csrfToken }, data: { controllerId: "devbox", ...input } }); assert.equal(denied.status(), 403);
  }
  assert.equal(await fixture.managed.store.read("unauthorized", fixture.managed.connection.hostId), undefined);
  assert.deepEqual(errors, []); process.stdout.write("Native Git project creation and two public repository import browser workflows passed.\n");
} catch (error) { if (errors.length) process.stderr.write(`Browser errors: ${errors.join("; ")}\n`); throw error; }
finally { await browser.close(); await fixture.close(); }
