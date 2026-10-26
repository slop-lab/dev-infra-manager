import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createLlmRouterClient } from "../../../../packages/service-clients/llm-router/src/index.js";
import { llmWebFixture } from "./fixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM is required");

const fixture = await llmWebFixture();
const client = createLlmRouterClient(fixture.connectionFile);
const capabilities = await client.capabilities();
for (const operation of [
  { name: "accounts", description: "Accounts", access: "read" as const },
  { name: "account.login.start", description: "Start login", access: "operator" as const },
]) if (!capabilities.some(({ name }) => name === operation.name)) capabilities.push(operation);
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const page = await browser.newPage();
  let discoveries = 0;
  let loginStarts = 0;
  await page.route("**/v1/extensions", async (route) => {
    const response = await route.fetch();
    const features = await response.json() as Array<{ id: string; operations: Array<{ name: string; description: string; access: string }> }>;
    const operations = features.find(({ id }) => id === "llm-router")?.operations;
    assert(operations);
    operations.unshift({ name: "controllers.list", description: "Router controllers", access: "read" });
    for (const operation of capabilities) if (!operations.some(({ name }) => name === operation.name)) operations.push(operation);
    await route.fulfill({ response, json: features });
  });
  await page.route("**/v1/extensions/llm-router/operations/*", async (route) => {
    const name = route.request().url().split("/").at(-1);
    if (name === "controllers.list") {
      discoveries++;
      await route.fulfill({ json: { controllers: [{ id: "first", controllerKey: "first", title: "first", status: "ready", operations: capabilities }] } });
      return;
    }
    const { controllerId: _controllerId, ...input } = route.request().postDataJSON() as Record<string, unknown>;
    if (name === "accounts") {
      await route.fulfill({ json: [{ id: "codex-one", reference: "Codex one", provider: "codex", status: "authorization_required" }] });
      return;
    }
    if (name === "account.login.start") {
      loginStarts++;
      await route.fulfill({ status: 503, json: { error: "synthetic unknown login start" } });
      return;
    }
    await route.fulfill({ json: await client.invoke(String(name), input) });
  });

  await page.goto(fixture.origin);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "LLM router", exact: true }).click();
  const account = page.locator('[data-account-id="codex-one"]');
  const signIn = account.getByRole("button", { name: "Sign in", exact: true });
  await signIn.click();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  assert.equal(await signIn.isDisabled(), true);
  assert.equal(loginStarts, 1);

  await page.getByRole("button", { name: "Refresh router controllers", exact: true }).click();
  await page.getByText(/cannot change or rediscover router controllers/i).waitFor();
  assert.equal(discoveries, 1);
  assert.equal(await signIn.isDisabled(), true);
  await signIn.click({ force: true });
  assert.equal(loginStarts, 1);
  assert.equal(fixture.inferenceRequests(), 0);
  process.stdout.write("Unknown provider-login ownership survives attempted controller rediscovery without duplicate dispatch.\n");
} finally {
  await browser.close();
  await fixture.close();
}
