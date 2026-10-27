import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createOperationsBrowserFixture } from "./operationsBrowserFixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const fixture = await createOperationsBrowserFixture();
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
async function signIn(): Promise<void> {
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
try {
  await page.goto(`${fixture.origin}/#/settings/access`);
  await signIn();
  await page.locator('#settings-panel [data-settings-section="access"]').waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).hash, "#/settings/access");
  await page.reload();
  await page.locator('#settings-panel [data-settings-section="access"]').waitFor({ state: "visible" });
  await page.getByRole('link', { name: 'Skip to main content', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(new URL(page.url()).hash, '#/settings/access');
  assert.equal(await page.locator('#main').evaluate((main) => main === document.activeElement), true);
  await page.getByRole("link", { name: "Capabilities & connections", exact: true }).click();
  await page.getByRole("heading", { name: "Installed Web capabilities", exact: true }).waitFor();
  await page.goBack();
  await page.locator('#settings-panel [data-settings-section="access"]').waitFor({ state: "visible" });
  await page.goForward();
  await page.getByRole("heading", { name: "Installed Web capabilities", exact: true }).waitFor();
  const tab = await page.context().newPage();
  await tab.goto(`${fixture.origin}/#/settings/access`);
  await tab.locator('#settings-panel [data-settings-section="access"]').waitFor({ state: "visible" });
  await tab.close();
  await page.getByRole("link", { name: "Workspaces", exact: true }).click();
  await page.getByRole("link", { name: "New workspace on devbox", exact: true }).click();
  const draft = page.getByRole("form", { name: "New workspace on devbox", exact: true });
  await draft.getByLabel("Workspace name on devbox", { exact: true }).fill("retained-draft");
  await page.getByRole("link", { name: "Settings & access", exact: true }).click();
  await page.goBack();
  await draft.waitFor({ state: "visible" });
  assert.equal(await draft.getByLabel("Workspace name on devbox", { exact: true }).inputValue(), "retained-draft");
  await page.goto(`${fixture.origin}/#/features/missing-service`);
  await page.getByRole("heading", { name: "Page unavailable", exact: true }).waitFor();
  assert.equal(await page.locator("#operations-panel").isVisible(), false);
  await page.goto(`${fixture.origin}/#/workspaces/not-configured/unknown`);
  await page.getByText('The requested host is not configured in this console.', {exact:false}).waitFor();
  assert.equal(await page.locator('.workspace-row:visible').count(),0);
  await page.goto(`${fixture.origin}/#/settings/access`);
  await page.locator('#settings-panel [data-settings-section="access"]').waitFor({ state: "visible" });
  await page.evaluate(async () => {
    const response = await fetch("/v1/session");
    const session: { csrfToken: string } = await response.json();
    await fetch("/v1/session", { method: "DELETE", headers: { "x-dim-csrf": session.csrfToken } });
  });
  await page.reload();
  await page.locator("#login-view").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).hash, "#/settings/access");
  await signIn();
  await page.locator('#settings-panel [data-settings-section="access"]').waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.locator("#login-view").waitFor({ state: "visible" });
  assert.equal(await page.locator("#settings-panel").innerText(), "");
  assert.deepEqual((await fixture.actions()).filter((action) => action !== "ls"), []);
  assert.deepEqual(errors, []);
  process.stdout.write("Console deep links, login return, reload, Back/Forward, new tabs, retained draft, unavailable destination and ended-session recovery passed without domain mutations.\n");
} finally {
  await browser.close();
  await fixture.close();
}
