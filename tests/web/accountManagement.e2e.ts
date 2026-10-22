import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { initializeOperationsWeb } from "../../packages/web/core/src/initialize.js";
import { parseWebConfig } from "../../packages/web/core/src/config.js";
import { createWebServerFromConfigFile } from "../../packages/web/core/src/server.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const root = await mkdtemp(join(tmpdir(), "dim-account-management-"));
let web: Awaited<ReturnType<typeof createWebServerFromConfigFile>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const operations = join(root, "operations.json"), config = join(root, "web.json"), executable = join(root, "controller");
  await writeFile(executable, `#!${process.execPath}\n// @ts-check\nprocess.stdout.write('[]\\n');\n`, { mode: 0o700 });
  await writeFile(operations, JSON.stringify({ hosts: [{ id: "devbox", selector: "fixture", executable }] }), { mode: 0o600 });
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("missing fixture port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const login = await initializeOperationsWeb({ operations, output: config, port: address.port });
  const initial = parseWebConfig(JSON.parse(await readFile(config, "utf8")));
  assert(initial.accounts[0]?.roles.includes("account-admin"));
  web = await createWebServerFromConfigFile(config); const origin = await web.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  await page.addInitScript(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText() { return Promise.reject(new Error("Clipboard unavailable")); } } });`);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin); await page.getByLabel("Username", { exact: true }).fill(login.username); await page.getByLabel("Password", { exact: true }).fill(login.password); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Account & access", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Account & access", exact: true }), form = dialog.getByRole("form", { name: "Manage browser account", exact: true });
  await dialog.getByRole("cell", { name: login.username, exact: true }).waitFor();
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    if (process.env.DIM_WEB_EVIDENCE) { await mkdir(process.env.DIM_WEB_EVIDENCE, { recursive: true }); await page.screenshot({ path: join(process.env.DIM_WEB_EVIDENCE, `dim-account-management-${width}.png`), fullPage: true }); }
  }
  let releaseSnapshot: () => void = () => {}, markSnapshot: () => void = () => {};
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; }), snapshotReady = new Promise<void>((resolve) => { markSnapshot = resolve; });
  await page.route("**/v1/accounts", async (route) => { const response = await route.fetch(); markSnapshot(); await snapshotGate; await route.fulfill({ response }); }, { times: 1 });
  await dialog.getByRole("button", { name: "Refresh accounts", exact: true }).click(); await snapshotReady;
  await form.getByLabel("Account username", { exact: true }).fill("browser-reviewer"); await form.getByLabel("Grant reviewer", { exact: true }).check();
  await form.getByLabel("Your current password", { exact: true }).fill("wrong-password"); await form.getByRole("button", { name: "Save account", exact: true }).click();
  await dialog.getByText("Current password is incorrect", { exact: true }).waitFor();
  await page.waitForFunction(() => { const button = document.querySelector('form[aria-label="Manage browser account"] button[type="submit"]'); return button instanceof HTMLButtonElement && !button.disabled; });
  assert.equal(await form.getByLabel("Your current password", { exact: true }).inputValue(), "");
  assert.equal(await dialog.getByRole("cell", { name: "browser-reviewer", exact: true }).count(), 0);
  await form.getByLabel("Your current password", { exact: true }).fill(login.password); await form.getByRole("button", { name: "Save account", exact: true }).click();
  await dialog.getByText("Account browser-reviewer: add saved. Changes apply immediately.", { exact: true }).waitFor();
  const snapshotFinished = page.waitForResponse((response) => response.url() === origin + "/v1/accounts" && response.request().method() === "GET"); releaseSnapshot(); await (await snapshotFinished).finished();
  await page.waitForTimeout(100); // Let the delayed pre-write list response render if it was not invalidated.
  assert.equal(await dialog.getByRole("cell", { name: "browser-reviewer", exact: true }).count(), 1);
  assert.equal(await form.getByRole("button", { name: "Save account", exact: true }).isDisabled(), true);
  const generated = dialog.getByLabel("Generated password", { exact: true }); const reviewerPassword = await generated.inputValue(); assert(reviewerPassword.length > 20);
  await dialog.getByRole("button", { name: "Copy generated password", exact: true }).click(); await dialog.getByText("Password selected. Copy it with your keyboard.", { exact: true }).waitFor();
  const reviewerContext = await browser.newContext(), reviewerPage = await reviewerContext.newPage(); reviewerPage.setDefaultTimeout(15_000);
  await reviewerPage.goto(origin); await reviewerPage.getByLabel("Username", { exact: true }).fill("browser-reviewer"); await reviewerPage.getByLabel("Password", { exact: true }).fill(reviewerPassword); await reviewerPage.getByRole("button", { name: "Sign in", exact: true }).click(); await reviewerPage.getByRole("button", { name: "Account & access", exact: true }).waitFor();
  assert.equal((await reviewerPage.request.get(origin + "/v1/accounts")).status(), 403);
  await reviewerPage.getByRole("button", { name: "Account & access", exact: true }).click(); assert.equal(await reviewerPage.getByRole("form", { name: "Manage browser account", exact: true }).count(), 0);
  const row = dialog.locator("tr").filter({ has: page.getByRole("cell", { name: "browser-reviewer", exact: true }) });
  await row.getByRole("button", { name: "Reset password", exact: true }).click(); await form.getByLabel("Your current password", { exact: true }).fill(login.password);
  page.once("dialog", (confirmation) => confirmation.dismiss()); await form.getByRole("button", { name: "Save account", exact: true }).click(); await dialog.getByText("Account change dismissed.", { exact: true }).waitFor();
  assert.equal((await reviewerPage.request.get(origin + "/v1/session")).status(), 200);
  await form.getByLabel("Your current password", { exact: true }).fill(login.password); page.once("dialog", (confirmation) => confirmation.accept()); await form.getByRole("button", { name: "Save account", exact: true }).click();
  await dialog.getByText("Account browser-reviewer: reset-password saved. Changes apply immediately.", { exact: true }).waitFor();
  const resetPassword = await generated.inputValue(); assert.notEqual(resetPassword, reviewerPassword);
  assert.equal((await reviewerPage.request.get(origin + "/v1/session")).status(), 401);
  assert.equal((await page.request.get(origin + "/v1/session")).status(), 200);
  await row.getByRole("button", { name: "Remove", exact: true }).click(); await form.getByLabel("Your current password", { exact: true }).fill(login.password); page.once("dialog", (confirmation) => confirmation.accept()); await form.getByRole("button", { name: "Save account", exact: true }).click();
  await dialog.getByText(/Account browser-reviewer: remove saved\.|Authentication is busy\./).waitFor();
  if (await dialog.getByText(/^Authentication is busy\./).isVisible()) {
    await page.waitForTimeout(1_100); await form.getByLabel("Your current password", { exact: true }).fill(login.password); page.once("dialog", (confirmation) => confirmation.accept()); await form.getByRole("button", { name: "Save account", exact: true }).click();
  }
  try { await dialog.getByText("Account browser-reviewer: remove saved. Changes apply immediately.", { exact: true }).waitFor(); }
  catch (error) { process.stderr.write(`${await dialog.innerText()}\nBrowser errors: ${errors.join("; ")}\n`); throw error; } assert.equal(await dialog.getByRole("cell", { name: "browser-reviewer", exact: true }).count(), 0); assert.equal(await generated.count(), 0);
  const own = dialog.locator("tr").filter({ has: page.getByRole("cell", { name: login.username, exact: true }) });
  await page.waitForTimeout(1_100); // Refill the shared authentication burst after the rapid mutation journey.
  await own.getByRole("button", { name: "Edit roles", exact: true }).click(); await form.getByLabel("Grant account-admin", { exact: true }).uncheck(); await form.getByLabel("Your current password", { exact: true }).fill(login.password); await form.getByRole("button", { name: "Save account", exact: true }).click();
  await dialog.getByText(/last account administrator/i).waitFor(); assert.equal((await page.request.get(origin + "/v1/session")).status(), 200);
  await page.waitForTimeout(1_100);
  await form.getByLabel("Grant account-admin", { exact: true }).check(); await form.getByLabel("Grant reviewer", { exact: true }).check(); await form.getByLabel("Your current password", { exact: true }).fill(login.password); await form.getByRole("button", { name: "Save account", exact: true }).click();
  await dialog.getByRole("button", { name: "Sign in again", exact: true }).waitFor(); await dialog.getByRole("button", { name: "Sign in again", exact: true }).click();
  await page.waitForTimeout(1_100);
  await page.getByLabel("Username", { exact: true }).fill(login.username); await page.getByLabel("Password", { exact: true }).fill(login.password); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("button", { name: "Account & access", exact: true }).click();
  await dialog.getByText("Enabled: reviewer — Approve or revoke reviews required from the configured reviewer", { exact: true }).waitFor();
  const saved = parseWebConfig(JSON.parse(await readFile(config, "utf8"))); assert.deepEqual(saved.operations, initial.operations); assert.equal(saved.accounts[0]?.passwordHash, initial.accounts[0]?.passwordHash);
  await dialog.getByRole("cell", { name: login.username, exact: true }).waitFor();
  await dialog.locator("tr").filter({ has: page.getByRole("cell", { name: login.username, exact: true }) }).getByRole("button", { name: "Reset password", exact: true }).click();
  await page.waitForTimeout(1_100); await form.getByLabel("Your current password", { exact: true }).fill(login.password); page.once("dialog", (confirmation) => confirmation.accept()); await form.getByRole("button", { name: "Save account", exact: true }).click();
  await dialog.getByRole("button", { name: "Sign in again", exact: true }).waitFor();
  const selfPassword = await generated.inputValue(); assert.notEqual(selfPassword, login.password); assert.equal((await page.request.get(origin + "/v1/session")).status(), 401); assert.equal(await generated.inputValue(), selfPassword);
  await page.keyboard.press("Escape"); await page.getByLabel("Username", { exact: true }).fill(login.username); await page.getByLabel("Password", { exact: true }).fill(selfPassword); await page.waitForTimeout(1_100); await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("button", { name: "Account & access", exact: true }).waitFor();
  assert.deepEqual(errors, []); await reviewerContext.close(); process.stdout.write("Browser account add, reauthentication, password reset, removal, last-admin protection and live self-role recovery passed.\n");
} finally { await browser?.close(); await web?.close(); await rm(root, { recursive: true, force: true }); }
