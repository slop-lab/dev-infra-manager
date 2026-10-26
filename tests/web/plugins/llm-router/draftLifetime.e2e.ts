import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { llmWebFixture } from "./fixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM is required");

const fixture = await llmWebFixture();
const browser = await chromium.launch({ executablePath, headless: true });
let releaseProjectCreate: () => void = () => {};
let markProjectCreate: () => void = () => {};
const projectCreateGate = new Promise<void>((resolve) => { releaseProjectCreate = resolve; });
const projectCreateStarted = new Promise<void>((resolve) => { markProjectCreate = resolve; });
let releaseKnownRename: () => void = () => {};
let markKnownRename: () => void = () => {};
const knownRenameGate = new Promise<void>((resolve) => { releaseKnownRename = resolve; });
const knownRenameStarted = new Promise<void>((resolve) => { markKnownRename = resolve; });
let releaseUnknownRename: () => void = () => {};
let markUnknownRename: () => void = () => {};
const unknownRenameGate = new Promise<void>((resolve) => { releaseUnknownRename = resolve; });
const unknownRenameStarted = new Promise<void>((resolve) => { markUnknownRename = resolve; });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  const account = { id: "editable-account", reference: "Editable account", provider: "codex", status: "connected" };
  let renameCalls = 0;
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("**/v1/extensions", async (route) => {
    const response = await route.fetch();
    const features = await response.json() as Array<{ id: string; operations: Array<{ name: string; description: string; access: string }> }>;
    const feature = features.find(({ id }) => id === "llm-router");
    assert(feature);
    for (const name of ["accounts", "account.rename"]) {
      if (!feature.operations.some((operation) => operation.name === name)) feature.operations.push({ name, description: name, access: name === "accounts" ? "read" : "operator" });
    }
    await route.fulfill({ response, json: features });
  });
  await page.route("**/v1/extensions/llm-router/operations/*", async (route) => {
    const name = route.request().url().split("/").at(-1);
    if (name === "accounts") { await route.fulfill({ json: [account] }); return; }
    if (name !== "account.rename") { await route.continue(); return; }
    const input = route.request().postDataJSON() as { accountId: string; reference: string };
    assert.equal(input.accountId, account.id);
    account.reference = input.reference;
    renameCalls++;
    if (renameCalls === 1) {
      markKnownRename();
      await knownRenameGate;
      await route.fulfill({ json: account });
      return;
    }
    markUnknownRename();
    await unknownRenameGate;
    await route.fulfill({ status: 503, json: { error: "synthetic lost accepted rename response" } });
  });
  await page.route("**/v1/extensions/llm-router/operations/project.create", async (route) => {
    const response = await route.fetch();
    markProjectCreate();
    await projectCreateGate;
    await route.fulfill({ response });
  }, { times: 1 });

  // Given an editable project-create form with a delayed accepted response.
  await page.goto(fixture.origin);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "LLM router", exact: true }).click();
  await page.getByRole("link", { name: "Projects & policy", exact: true }).click();
  await page.getByText("New routing project", { exact: true }).click();
  const projectName = page.getByLabel("Project ID", { exact: true });
  await projectName.fill("submitted-project");

  // When the user starts another draft and leaves while the older create completes.
  await page.getByRole("button", { name: "Create routing project", exact: true }).click();
  await projectCreateStarted;
  await projectName.fill("next-project");
  await page.getByRole("link", { name: "Accounts & routes", exact: true }).click();
  releaseProjectCreate();
  await page.waitForFunction(() => !document.querySelector('button[data-pending="true"]'));

  // Then the newer name remains editable and the newer browser destination wins.
  assert.equal(await projectName.inputValue(), "next-project");
  assert.equal(await page.locator('form[aria-label="New routing project"] button').isEnabled(), true);
  assert.match(page.url(), /#\/features\/llm-router\/accounts$/);

  // Given an account rename whose accepted response is delayed.
  const accountRow = page.locator(`[data-account-id="${account.id}"]`);
  await accountRow.getByText("Rename account", { exact: true }).click();
  await accountRow.getByLabel("Display name", { exact: true }).fill("Submitted name");

  // When a newer rename draft is entered before the known-success response arrives.
  await accountRow.getByRole("button", { name: "Save name", exact: true }).click();
  await knownRenameStarted;
  await accountRow.getByLabel("Display name", { exact: true }).fill("Next known name");
  releaseKnownRename();
  await page.getByRole("heading", { name: "Submitted name", exact: true }).waitFor();
  const knownResult = page.locator(`[data-account-id="${account.id}"]`);

  // Then the newer draft remains available for a separate rename.
  assert.equal(await knownResult.getByLabel("Display name", { exact: true }).inputValue(), "Next known name");
  assert.equal(await knownResult.locator('form[aria-label^="Rename "] button').isEnabled(), true);

  // Given another delayed rename whose accepted response is lost.
  await knownResult.getByText("Rename account", { exact: true }).click();
  await knownResult.getByLabel("Display name", { exact: true }).fill("Reconciled name");
  await knownResult.getByRole("button", { name: "Save name", exact: true }).click();
  await unknownRenameStarted;
  await knownResult.getByLabel("Display name", { exact: true }).fill("Next reconciled name");
  releaseUnknownRename();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();

  // When a current account read reconciles the older committed rename.
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.getByRole("heading", { name: "Reconciled name", exact: true }).waitFor();
  const reconciledResult = page.locator(`[data-account-id="${account.id}"]`);

  // Then reconciliation preserves and unlocks the newer draft.
  assert.equal(await reconciledResult.getByLabel("Display name", { exact: true }).inputValue(), "Next reconciled name");
  assert.equal(await reconciledResult.locator('form[aria-label^="Rename "] button').isEnabled(), true);
  assert.equal(renameCalls, 2);
  assert.deepEqual(errors, []);
  assert.equal(fixture.inferenceRequests(), 0);
  process.stdout.write("Late project creation and account rename outcomes preserve newer same-form drafts and destinations.\n");
} finally {
  releaseProjectCreate();
  releaseKnownRename();
  releaseUnknownRename();
  await browser.close();
  await fixture.close();
}
