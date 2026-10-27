import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createNonGitWorkbench } from "./non-git-workbench/harness.js";
import { WORKSPACE_IDS } from "./non-git-workbench/state.js";

const fixture = await createNonGitWorkbench();
const browser = await chromium.launch({ executablePath: process.env.DIM_CHROMIUM ?? "/usr/bin/chromium", headless: true });
try {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.origin });
  const operator = await context.newPage();
  await operator.goto(`${fixture.origin}/#/workspaces/local/${WORKSPACE_IDS.running}/tools`);
  await operator.getByLabel("Username", { exact: true }).fill(fixture.username);
  await operator.getByLabel("Password", { exact: true }).fill(fixture.password);
  await operator.getByRole("button", { name: "Sign in", exact: true }).click();
  await operator.getByRole("button", { name: "Copy server password", exact: true }).waitFor();
  await operator.getByLabel("New server password", { exact: true }).fill("synthetic-draft-only");
  await operator.evaluate(() => navigator.clipboard.writeText("clipboard-sentinel"));

  let releaseResponse = () => {};
  const released = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let responseReady = () => {};
  const ready = new Promise<void>((resolve) => { responseReady = resolve; });
  let responseDelivered = () => {};
  const delivered = new Promise<void>((resolve) => { responseDelivered = resolve; });
  await operator.route("**/v1/extensions/agent-tools/operations/server.credentials", async (route) => {
    const response = await route.fetch();
    responseReady();
    await released;
    await route.fulfill({ response });
    responseDelivered();
  });
  await operator.getByRole("button", { name: "Copy server password", exact: true }).click();
  await ready;

  const evaluator = await context.newPage();
  await evaluator.goto(fixture.origin);
  await evaluator.getByRole("button", { name: "Sign out", exact: true }).click();
  await evaluator.getByLabel("Username", { exact: true }).fill(fixture.readonlyUsername);
  await evaluator.getByLabel("Password", { exact: true }).fill(fixture.password);
  await evaluator.getByRole("button", { name: "Sign in", exact: true }).click();
  await evaluator.getByText(/evaluator.*read/).waitFor();
  await operator.locator("#login-error").getByText("The browser session changed in another tab. Sign in again.", { exact: true }).waitFor();

  releaseResponse();
  await delivered;
  assert.equal((await operator.locator("body").innerText()).includes("synthetic-only-password"), false);
  assert.equal((await operator.locator("body").innerText()).includes("synthetic-draft-only"), false);
  assert.equal(await operator.locator('input[value="synthetic-draft-only"]').count(), 0);
  assert.equal(await operator.evaluate(() => navigator.clipboard.readText()), "clipboard-sentinel");
  assert.equal(await evaluator.getByRole("button", { name: "Copy server password", exact: true }).count(), 0);
  await operator.getByLabel('Username',{exact:true}).fill(fixture.username); await operator.getByLabel('Password',{exact:true}).fill(fixture.password); await operator.getByRole('button',{name:'Sign in',exact:true}).click();
  await operator.locator('#session-actions').waitFor({state:'visible'});
  await operator.getByRole('button',{name:'Account & access',exact:true}).click();
  const access = operator.getByRole('dialog',{name:'Account & access',exact:true});
  await access.getByLabel('Account action',{exact:true}).selectOption('reset-password'); await access.getByLabel('Account username',{exact:true}).fill(fixture.username); await access.getByLabel('Your current password',{exact:true}).fill(fixture.password);
  operator.once('dialog',dialog=>dialog.accept()); await access.getByRole('button',{name:'Save account',exact:true}).click();
  const receipt = access.getByLabel('Generated password',{exact:true}); await receipt.waitFor(); const generated = await receipt.inputValue(); assert(generated.length>20);
  await evaluator.getByLabel('Username',{exact:true}).fill(fixture.readonlyUsername); await evaluator.getByLabel('Password',{exact:true}).fill(fixture.password); await evaluator.getByRole('button',{name:'Sign in',exact:true}).click();
  await evaluator.locator('#session-actions').waitFor({state:'visible'}); await access.waitFor({state:'hidden'});
  assert.equal(await operator.locator('input').evaluateAll((fields,secret)=>fields.some(field=>field instanceof HTMLInputElement && field.value===secret),generated),false);
  const storageBlocked = await context.newPage();
  await storageBlocked.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("blocked", "SecurityError"); };
  });
  await storageBlocked.goto(fixture.origin);
  await storageBlocked.locator("#login-error").getByText("This browser blocks the local session fence. Allow local storage for this console, then reload.", { exact: true }).waitFor();
  assert.equal(await storageBlocked.locator("#session-actions").isHidden(), true);
  process.stdout.write("Cross-tab session fencing cleared operator DOM and blocked delayed secret clipboard writes.\n");
} finally {
  await browser.close();
  await fixture.close();
}
