import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createNativeManagementBrowserFixture } from "./nativeManagementBrowserFixture.js";
const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const fixture = await createNativeManagementBrowserFixture(), browser = await chromium.launch({ executablePath, headless: true }), page = await browser.newPage();
page.setDefaultTimeout(30_000);
const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
let imports = 0; page.on("request", (request) => { if (request.url().endsWith("/operations/repositories.import-manifest")) imports++; });
const manifest = `schemaVersion: 1
repositories:
  public:
    ref: main
    protect: [main]
    upstream: {url: https://github.com/mjy9088/codyssey-public.git, branch: main}
    publish: {main: development}
  companion:
    ref: main
    protect: [main]
    upstream: {url: https://github.com/mjy9088/codyssey-private.git, branch: main}
policy:
  code-review: {requiredReviewerIds: [], pathReviewerRules: []}
  merge-policy: {}
`;
try {
  await page.goto(fixture.origin); await page.getByLabel("Username", { exact: true }).fill(fixture.username); await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("button", { name: "Git review", exact: true }).click();
  await page.getByText("New project", { exact: true }).click(); const create = page.getByRole("form", { name: "New managed project" });
  await create.getByLabel("New project ID").fill("manifest-browser"); await create.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForFunction(() => { const input = document.querySelector('select[aria-label="Project"]'); return input instanceof HTMLSelectElement && input.value === "manifest-browser"; });
  await page.getByText("Import .dim/repos.yml", { exact: true }).click(); const form = page.getByRole("form", { name: "Import repository manifest" });
  const input = form.getByLabel(".dim/repos.yml contents", { exact: true }), preview = form.getByRole("button", { name: "Preview manifest", exact: true }), submit = form.getByRole("button", { name: "Import manifest repositories", exact: true });
  await input.fill("schemaVersion: 1\nrepositories: {}\n"); await preview.click(); await form.getByText(/Could not preview manifest:/).waitFor(); assert.equal(imports, 0);
  await form.getByLabel("Select repos.yml file", { exact: true }).setInputFiles({ name: "repos.yml", mimeType: "text/yaml", buffer: Buffer.from(manifest) }); await form.getByText("File loaded. Preview the manifest before importing.", { exact: true }).waitFor(); assert.equal(await input.inputValue(), manifest); await preview.click(); await form.getByText(/Configuration repository: public. Default checkout: public./).waitFor();
  assert.equal(await submit.isEnabled(), true); await input.fill(manifest + "\n"); assert.equal(await submit.isHidden(), true);
  await preview.click(); await submit.waitFor();
  await form.getByText(/Default checkout branch: refs\/heads\/main\. Protected branches:/).first().waitFor();
  let failCatalog = true; await page.route("**/v1/extensions/native-git/operations/projects.list", async (route) => { if (failCatalog) { failCatalog = false; await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture read unavailable"}' }); } else await route.continue(); });
  await submit.click(); await form.getByText(/Manifest imported: .*Latest project catalog could not refresh/).waitFor(); assert.equal(await submit.isDisabled(), true); assert.equal(imports, 1);
  await submit.dispatchEvent("click"); assert.equal(imports, 1);
  const record = await fixture.managed.store.read("manifest-browser", fixture.managed.connection.hostId); assert(record); assert.equal(record.phase, "ready"); assert.deepEqual(Object.keys(record.repositories).sort(), ["companion", "public"]); assert.equal(record.defaultWorkingRepositoryId, "public"); assert.equal(record.configurationRepositoryId, "public");
  assert.equal((await page.locator("body").innerText()).includes(fixture.managed.root), false);
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.getByLabel("Username", { exact: true }).fill("readonly"); await page.getByLabel("Password", { exact: true }).fill(fixture.password); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("button", { name: "Git review", exact: true }).click();
  assert.equal(await page.getByRole("form", { name: "Import repository manifest" }).isHidden(), true);
  assert.deepEqual(errors, []); process.stdout.write("Native Git manifest preview, policy acceptance, two-repository import and accepted receipt browser workflow passed.\n");
} catch (error) { process.stderr.write((await page.locator("body").innerText()) + "\n"); throw error; } finally { await browser.close(); await fixture.close(); }
