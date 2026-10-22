import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { initializeOperationsWeb } from "../../packages/web/core/src/initialize.js";
import { parseWebConfig } from "../../packages/web/core/src/config.js";
import { createWebServerFromConfigFile } from "../../packages/web/core/src/server.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const execute = promisify(execFile), root = await mkdtemp(join(tmpdir(), "dim-account-browser-"));
let web: Awaited<ReturnType<typeof createWebServerFromConfigFile>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const operations = join(root, "operations.json"), config = join(root, "web's config.json");
  const controller = join(root, "controller");
  await writeFile(controller, `#!${process.execPath}\n// @ts-check\nprocess.stdout.write('[]\\n');\n`, { mode: 0o700 });
  await writeFile(operations, JSON.stringify({ hosts: [{ id: "devbox", selector: "fixture", executable: controller }] }), { mode: 0o600 });
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("missing fixture port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const login = await initializeOperationsWeb({ operations, output: config, port: address.port });
  const saved = parseWebConfig(JSON.parse(await readFile(config, "utf8"))), operator = saved.accounts[0]; assert(operator);
  const username = "-operator's account";
  await writeFile(config, JSON.stringify({ ...saved, accounts: [{ ...operator, username }, { ...operator, username: "readonly", roles: ["read"] }] }), { mode: 0o600 });
  web = await createWebServerFromConfigFile(config);
  const origin = await web.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  await page.addInitScript(`Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText() { return Promise.reject(new Error("Clipboard access denied by browser")); } } });`);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  async function signIn(name: string) {
    await page.goto(origin); await page.getByLabel("Username", { exact: true }).fill(name); await page.getByLabel("Password", { exact: true }).fill(login.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("button", { name: "Account & access", exact: true }).waitFor();
  }
  await signIn(username);
  await page.getByRole("button", { name: "Account & access", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Account & access", exact: true });
  await dialog.getByText("Not granted: reviewer — Approve or revoke reviews required from the configured reviewer", { exact: true }).waitFor();
  const commandInput = dialog.getByLabel("Enable review access for this account", { exact: true });
  const command = await commandInput.inputValue();
  assert(command.includes("'set-roles'")); assert(command.includes("'--roles' 'read,operator,reviewer'"));
  await dialog.getByRole("button", { name: "Copy enable review access for this account", exact: true }).click();
  try { await dialog.getByText("Command selected. Copy it with your keyboard.", { exact: true }).waitFor(); }
  catch (error) { process.stderr.write(`${await dialog.innerText()}\nBrowser errors: ${errors.join("; ")}\n`); throw error; }
  assert.equal(await commandInput.evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!), command.length);
  await page.keyboard.press("Escape"); assert.equal(await dialog.isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "Account & access", exact: true }).evaluate((button) => button === document.activeElement), true);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn("readonly"); await page.getByRole("button", { name: "Account & access", exact: true }).click();
  await dialog.getByText("Ask the console owner to configure browser access on the console server. Account permissions cannot be changed from this browser.", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: /^Copy / }).count(), 0);
  assert.equal((await dialog.innerText()).includes(config), false);
  const readonlySession: unknown = await (await page.request.get(origin + "/v1/session")).json();
  assert(typeof readonlySession === "object" && readonlySession !== null && !("accountAdministration" in readonlySession));
  await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const before = parseWebConfig(JSON.parse(await readFile(config, "utf8")));
  // Execute exactly what the dialog provides, including shell quoting for the
  // username and configuration path. The source console uses its matching build.
  await execute("/bin/bash", ["-c", command], { timeout: 15_000 });
  const after = parseWebConfig(JSON.parse(await readFile(config, "utf8")));
  assert.equal(after.accounts.find((account) => account.username === username)?.passwordHash, before.accounts.find((account) => account.username === username)?.passwordHash);
  assert.deepEqual(after.operations, before.operations); assert.deepEqual(after.accounts.find((account) => account.username === "readonly"), before.accounts.find((account) => account.username === "readonly"));
  await signIn(username);
  const beforeRestart: unknown = await (await page.request.get(origin + "/v1/session")).json();
  assert(typeof beforeRestart === "object" && beforeRestart !== null && "roles" in beforeRestart && Array.isArray(beforeRestart.roles) && !beforeRestart.roles.includes("reviewer"));
  await web.close(); web = await createWebServerFromConfigFile(config); assert.equal(await web.listen(), origin);
  await signIn(username);
  await page.getByRole("button", { name: "Account & access", exact: true }).click();
  await dialog.getByText("Enabled: reviewer — Approve or revoke reviews required from the configured reviewer", { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel("Enable review access for this account", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  process.stdout.write("Account access guidance, clipboard fallback, readonly isolation and CLI role update with retained password passed.\n");
} finally { await browser?.close(); await web?.close(); await rm(root, { recursive: true, force: true }); }
