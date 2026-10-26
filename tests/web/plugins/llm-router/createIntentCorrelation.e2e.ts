import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { llmWebFixture } from "./fixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM is required");

const fixture = await llmWebFixture();
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const page = await browser.newPage();
  const accounts = [{ id: "account-one", reference: "Dedicated test account", provider: "backend", status: "configured" }];
  const submittedAccountIds: string[] = [];
  let exposeForeignProject = false;

  await page.route("**/v1/extensions", async (route) => {
    const response = await route.fetch();
    const features = await response.json() as Array<{ id: string; operations: Array<{ name: string; description: string; access: string }> }>;
    const feature = features.find(({ id }) => id === "llm-router");
    assert(feature);
    for (const name of ["accounts", "account.create", "account.login.start", "project.create"]) {
      if (!feature.operations.some((operation) => operation.name === name)) feature.operations.push({ name, description: name, access: name === "accounts" ? "read" : "operator" });
    }
    await route.fulfill({ response, json: features });
  });
  await page.route("**/v1/extensions/llm-router/operations/*", async (route) => {
    const operation = route.request().url().split("/").at(-1);
    if (operation === "overview") {
      const response = await route.fetch();
      const overview = await response.json() as { routes: unknown[] };
      await route.fulfill({ response, json: { ...overview, routes: [...overview.routes, { id: "other", accountId: "account-one", models: "all" }] } });
      return;
    }
    if (operation === "accounts") {
      await route.fulfill({ json: accounts });
      return;
    }
    if (operation === "account.create") {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      const id = String(input.accountId);
      submittedAccountIds.push(id);
      if (submittedAccountIds.length === 1) accounts.push({ id: "other-actor-account", reference: "Other actor", provider: String(input.provider), status: "authorization_required" });
      else accounts.push({ id, reference: "Retried intent", provider: String(input.provider), status: "authorization_required" });
      await route.fulfill({ status: 503, json: { error: "synthetic lost create response" } });
      return;
    }
    if (operation === "projects") {
      const response = await route.fetch();
      const projects = await response.json() as unknown[];
      await route.fulfill({ response, json: exposeForeignProject ? [...projects, { id: "shared-project", enabled: true, paused: false, policy: { allowedRoutes: ["other"] } }] : projects });
      return;
    }
    if (operation === "project.create") {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      assert.deepEqual(input, { projectId: "shared-project", routeId: "default" });
      exposeForeignProject = true;
      await route.fulfill({ status: 503, json: { error: "synthetic lost project response" } });
      return;
    }
    await route.continue();
  });

  // Given an account create whose response is lost while another actor creates the same provider.
  await page.goto(fixture.origin);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "LLM router", exact: true }).click();
  await page.getByRole("button", { name: "Connect Codex account", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();

  // When a current account read contains only the other actor's new account.
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.getByRole("heading", { name: "Other actor", exact: true }).waitFor();
  await page.waitForFunction(() => {
    const control = [...document.querySelectorAll("button")].find((button) => button.textContent === "Connect Codex account");
    return control instanceof HTMLButtonElement && !control.disabled;
  });

  // Then the foreign account does not claim acceptance, and retry reuses the exact intent UUID.
  assert.match(submittedAccountIds[0] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const connect = page.getByRole("button", { name: "Connect Codex account", exact: true });
  assert.equal(await connect.getAttribute("data-accepted"), null);
  assert.equal(await page.getByRole("button", { name: "Connect another Codex account", exact: true }).isVisible(), false);
  await connect.click();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  assert.equal(submittedAccountIds.length, 2);
  assert.equal(submittedAccountIds[1], submittedAccountIds[0]);
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.getByRole("heading", { name: "Retried intent", exact: true }).waitFor();
  const newIntent = page.getByRole("button", { name: "Connect another Codex account", exact: true });
  await newIntent.waitFor({ state: "visible" });
  await newIntent.click();
  await connect.click();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  assert.notEqual(submittedAccountIds[2], submittedAccountIds[1]);

  // Given a project create whose requested ID appears with another route after response loss.
  await page.reload();
  await page.getByRole("link", { name: "Projects & policy", exact: true }).click();
  await page.getByText("New routing project", { exact: true }).click();
  await page.getByLabel("Project ID", { exact: true }).fill("shared-project");
  await page.getByLabel("Project route", { exact: true }).selectOption("default");
  await page.getByRole("button", { name: "Create routing project", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();

  // When the foreign project is read authoritatively.
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => {
    const control = [...document.querySelectorAll("button")].find((button) => button.textContent === "Create routing project");
    return control instanceof HTMLButtonElement && !control.disabled;
  });

  // Then the UI does not claim that mismatched route as this create's accepted result.
  assert.equal(await page.getByLabel("Project ID", { exact: true }).inputValue(), "shared-project");
  assert.equal(await page.getByRole("button", { name: "Create routing project", exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "Create routing project", exact: true }).getAttribute("data-accepted"), null);
  assert.equal(fixture.inferenceRequests(), 0);
  process.stdout.write("Account and project creates reconcile only their exact submitted identities and routes.\n");
} finally {
  await browser.close();
  await fixture.close();
}
