import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createOperationsBrowserFixture } from "./operationsBrowserFixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const fixture = await createOperationsBrowserFixture();
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(fixture.origin);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "Open development on devbox", exact: true }).click();
  const row = page.locator(".workspace-row").filter({ has: page.getByRole("heading", { name: "development", exact: true }) });
  await row.getByText("Settings for development", { exact: true }).click();
  await row.getByLabel("CPUs for development", { exact: true }).fill("0.75");
  await fixture.delayNextAction("resources", 36_000);
  const response = Promise.allSettled([page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === "/v1/operations/hosts/devbox/workspaces", { timeout: 50_000 })]);
  await row.getByRole("button", { name: "Apply resources for development", exact: true }).click();
  assert.equal(await row.getByRole("button", { name: "Apply resources for development", exact: true }).isDisabled(), true);
  await row.getByText("development: resource limits refreshed from the host.", { exact: true }).waitFor({ timeout: 45_000 });
  const [received] = await response;
  assert(received?.status === "fulfilled", "the long operation must retain its response");
  assert.equal(received.value.status(), 200);
  assert.equal((await fixture.workspace()).resources.cpuCount, "0.75");
  assert.equal((await fixture.actions()).filter(action => action === "resources").length, 1);
  assert.equal(await row.getByLabel("CPUs for development", { exact: true }).inputValue(), "0.75");
  assert.deepEqual(errors, []);
  process.stdout.write("Long workspace mutation passed beyond the 35-second browser deadline (real browser/server transport, synthetic delayed CLI).\n");
} finally { await browser.close(); await fixture.close(); }
