import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { llmWebFixture } from "./fixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM is required");

const fixture = await llmWebFixture();
const browser = await chromium.launch({ executablePath, headless: true });
let releaseInitialRead: () => void = () => {};
let markInitialRead: () => void = () => {};
const initialReadGate = new Promise<void>((resolve) => { releaseInitialRead = resolve; });
const initialReadStarted = new Promise<void>((resolve) => { markInitialRead = resolve; });

try {
  const page = await browser.newPage();
  const currentAccounts = [
    { id: "account-one", reference: "Dedicated test account", provider: "backend", status: "configured" },
    { id: "existing-codex", reference: "Existing Codex", provider: "codex", status: "authorization_required" },
  ];
  let accountReads = 0;
  let createCalls = 0;

  await page.route("**/v1/extensions", async (route) => {
    const response = await route.fetch();
    const features = await response.json() as Array<{ id: string; operations: Array<{ name: string; description: string; access: string }> }>;
    const feature = features.find(({ id }) => id === "llm-router");
    assert(feature);
    for (const name of ["accounts", "account.create", "account.login.start"]) {
      if (!feature.operations.some((operation) => operation.name === name)) feature.operations.push({ name, description: name, access: name === "accounts" ? "read" : "operator" });
    }
    await route.fulfill({ response, json: features });
  });
  await page.route("**/v1/extensions/llm-router/operations/*", async (route) => {
    const name = route.request().url().split("/").at(-1);
    if (name === "accounts") {
      accountReads++;
      if (accountReads === 1) {
        markInitialRead();
        await initialReadGate;
        await route.fulfill({ json: currentAccounts.slice(0, 1) });
      } else if (accountReads === 4) {
        await route.fulfill({ status: 503, json: { error: "synthetic account read failure" } });
      } else {
        await route.fulfill({ json: currentAccounts });
      }
      return;
    }
    if (name === "account.create") {
      createCalls++;
      if (createCalls === 2) {
        const created = { id: "known-created", reference: "Codex account", provider: "codex", status: "authorization_required" };
        currentAccounts.push(created);
        await route.fulfill({ json: created });
      } else {
        await route.fulfill({ status: 503, json: { error: "synthetic lost response without commit" } });
      }
      return;
    }
    if (name === "account.login.start") {
      await route.fulfill({ status: 409, json: { error: "synthetic login unavailable" } });
      return;
    }
    await route.continue();
  });

  await page.goto(fixture.origin);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "LLM router", exact: true }).click();
  await initialReadStarted;

  const connect = page.getByRole("button", { name: "Connect Codex account", exact: true });
  assert.equal(await connect.isDisabled(), true);
  await connect.click({ force: true });
  assert.equal(createCalls, 0);

  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.getByRole("heading", { name: "Existing Codex", exact: true }).waitFor();
  assert.equal(await connect.isEnabled(), true);
  releaseInitialRead();
  await page.waitForTimeout(50);
  assert.equal(await page.getByRole("heading", { name: "Existing Codex", exact: true }).count(), 1);

  await connect.click();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Connect Codex account" && !button.disabled));
  assert.equal(await page.getByRole("button", { name: "Connect another Codex account", exact: true }).isVisible(), false);

  await connect.click();
  await page.getByText("Account added. Sign-in could not start; retry from its account row.", { exact: true }).waitFor();
  assert.equal(await connect.isDisabled(), true);
  const newIntent = page.getByRole("button", { name: "Connect another Codex account", exact: true });
  assert.equal(await newIntent.isVisible(), true);
  await newIntent.click();
  await connect.click();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Connect Codex account" && !button.disabled));
  assert.equal(createCalls, 3);
  assert.equal(fixture.inferenceRequests(), 0);
  process.stdout.write("Account creation waits for a current catalog, ignores stale reads, and preserves known-created identities across refresh failure.\n");
} finally {
  releaseInitialRead();
  await browser.close();
  await fixture.close();
}
