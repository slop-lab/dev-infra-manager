import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { llmWebFixture } from "./fixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM is required");

type Outcome = "known" | "unknown";
type Gate = { readonly started: Promise<void>; start: () => void; readonly release: Promise<void>; open: () => void };

function gate(): Gate {
  let start = (): void => {};
  let open = (): void => {};
  return {
    started: new Promise<void>((resolve) => { start = resolve; }),
    start: () => start(),
    release: new Promise<void>((resolve) => { open = resolve; }),
    open: () => open(),
  };
}

const fixture = await llmWebFixture();
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const page = await browser.newPage();
  const accounts = [{ id: "account-one", reference: "Dedicated test account", provider: "backend", status: "configured" }];
  const savedRoutes: Array<{ id: unknown; accountId: unknown; models: unknown }> = [];
  let createOutcome: Outcome = "known";
  let commitCreate = true;
  let createGate = gate();
  let routeOutcome: Outcome = "known";
  let routeGate = gate();
  const submittedAccountIds: string[] = [];

  await page.route("**/v1/extensions", async (route) => {
    const response = await route.fetch();
    const features = await response.json() as Array<{ id: string; operations: Array<{ name: string; description: string; access: string }> }>;
    const feature = features.find(({ id }) => id === "llm-router");
    assert(feature);
    for (const name of ["accounts", "account.create", "route.upsert"]) {
      if (!feature.operations.some((operation) => operation.name === name)) feature.operations.push({ name, description: name, access: name === "accounts" ? "read" : "operator" });
    }
    await route.fulfill({ response, json: features });
  });
  await page.route("**/v1/extensions/llm-router/operations/*", async (route) => {
    const operation = route.request().url().split("/").at(-1);
    if (operation === "overview") {
      const response = await route.fetch();
      const overview = await response.json() as { routes: unknown[] };
      await route.fulfill({ response, json: { ...overview, routes: [...overview.routes, ...savedRoutes] } });
      return;
    }
    if (operation === "accounts") {
      await route.fulfill({ json: accounts });
      return;
    }
    if (operation === "account.create") {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      const activeGate = createGate;
      activeGate.start();
      await activeGate.release;
      const id = String(input.accountId);
      submittedAccountIds.push(id);
      const account = { id, reference: String(input.reference ?? "API account"), provider: String(input.provider), status: "configured" };
      if (commitCreate) accounts.push(account);
      if (createOutcome === "known") await route.fulfill({ json: account });
      else await route.fulfill({ status: 503, json: { error: "synthetic lost API create response" } });
      return;
    }
    if (operation === "route.upsert") {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      const activeGate = routeGate;
      activeGate.start();
      await activeGate.release;
      savedRoutes.push({ id: input.routeId, accountId: input.accountId, models: input.models });
      if (routeOutcome === "known") await route.fulfill({ json: savedRoutes.at(-1) });
      else await route.fulfill({ status: 503, json: { error: "synthetic lost route response" } });
      return;
    }
    await route.continue();
  });

  await page.goto(fixture.origin);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "LLM router", exact: true }).click();

  async function openApiForm(): Promise<void> {
    const summary = page.getByText("Connect API provider", { exact: true });
    if (await page.getByRole("form", { name: "Connect API provider", exact: true }).isHidden()) await summary.click();
  }

  async function prepareApiCreate(outcome: Outcome, secret: string): Promise<void> {
    createOutcome = outcome;
    createGate = gate();
    await openApiForm();
    await page.getByLabel("Account label (optional)", { exact: true }).fill(`${outcome}-${secret}`);
    await page.getByLabel("API base URL", { exact: true }).fill("https://api.example.test/v1");
    await page.getByLabel("API key", { exact: true }).fill(secret);
    await page.getByRole("button", { name: "Add provider account", exact: true }).click();
    await createGate.started;
  }

  // Given a delayed accepted API create, when a newer key draft replaces the submitted key.
  await prepareApiCreate("known", "key-known-a");
  await page.getByLabel("API key", { exact: true }).fill("key-known-b");
  createGate.open();
  await page.waitForFunction(() => !document.querySelector('button[data-pending="true"]'));

  // Then the newer key stays editable.
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "key-known-b");
  assert.equal(await page.getByRole("button", { name: "Add provider account", exact: true }).isEnabled(), true);

  // Given a delayed accepted API create, when only the account label changes.
  await page.reload();
  await prepareApiCreate("known", "key-known-label-edit");
  await page.getByLabel("Account label (optional)", { exact: true }).fill("newer-label");
  createGate.open();
  await page.waitForFunction(() => !document.querySelector('button[data-pending="true"]'));

  // Then the submitted key is cleared while the unrelated newer draft remains editable.
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Account label (optional)", { exact: true }).inputValue(), "newer-label");
  assert.equal(await page.getByRole("button", { name: "Add provider account", exact: true }).isEnabled(), true);

  // Given an unchanged accepted API create, then only the submitted key is cleared.
  await page.reload();
  await prepareApiCreate("known", "key-known-unchanged");
  createGate.open();
  await page.waitForFunction(() => !document.querySelector('button[data-pending="true"]'));
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Add provider account", exact: true }).isDisabled(), true);

  // Given a lost API create that is absent from a completed authoritative read.
  await page.reload();
  commitCreate = false;
  await prepareApiCreate("unknown", "key-retry-same-id");
  createGate.open();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => {
    const control = [...document.querySelectorAll("button")].find((button) => button.textContent === "Add provider account");
    return control instanceof HTMLButtonElement && !control.disabled;
  });
  const firstRetryId = submittedAccountIds.at(-1);

  // When the user explicitly retries that absent create and it is accepted.
  commitCreate = true;
  await prepareApiCreate("unknown", "key-retry-same-id");
  createGate.open();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  const secondRetryId = submittedAccountIds.at(-1);

  // Then the retry uses the same UUID and reconciles the exact accepted account.
  assert.equal(secondRetryId, firstRetryId);
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => {
    const input = document.querySelector('input[aria-label="API key"]');
    return input instanceof HTMLInputElement && input.value === "";
  });

  // Given a lost accepted API create, when a newer key draft exists before reconciliation.
  await page.reload();
  await prepareApiCreate("unknown", "key-unknown-a");
  await page.getByLabel("API key", { exact: true }).fill("key-unknown-b");
  createGate.open();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => {
    const control = [...document.querySelectorAll("button")].find((button) => button.textContent === "Add provider account");
    return control instanceof HTMLButtonElement && !control.disabled;
  });

  // Then reconciliation keeps and unlocks the newer key draft.
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "key-unknown-b");
  assert.equal(await page.getByRole("button", { name: "Add provider account", exact: true }).isEnabled(), true);

  // Given a lost accepted API create with an unchanged submitted key, reconciliation clears that key.
  await page.reload();
  await prepareApiCreate("unknown", "key-unknown-unchanged");
  createGate.open();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => {
    const input = document.querySelector('input[aria-label="API key"]');
    return input instanceof HTMLInputElement && input.value === "";
  });
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Add provider account", exact: true }).isDisabled(), true);

  // Given a delayed accepted route save, when a newer route ID draft is entered.
  await page.reload();
  routeOutcome = "known";
  routeGate = gate();
  await page.getByLabel("Route ID", { exact: true }).fill("known-route-a");
  await page.getByLabel("Route account", { exact: true }).selectOption("account-one");
  await page.getByRole("button", { name: "Save route", exact: true }).click();
  await routeGate.started;
  await page.getByLabel("Route ID", { exact: true }).fill("known-route-b");
  routeGate.open();
  await page.waitForFunction(() => !document.querySelector('button[data-pending="true"]'));

  // Then the known completion cannot lock the newer route draft.
  assert.equal(await page.getByLabel("Route ID", { exact: true }).inputValue(), "known-route-b");
  assert.equal(await page.getByRole("button", { name: "Save route", exact: true }).isEnabled(), true);

  // Given a lost accepted route save, when a newer route ID draft exists before reconciliation.
  await page.reload();
  routeOutcome = "unknown";
  routeGate = gate();
  await page.getByLabel("Route ID", { exact: true }).fill("unknown-route-a");
  await page.getByLabel("Route account", { exact: true }).selectOption("account-one");
  await page.getByRole("button", { name: "Save route", exact: true }).click();
  await routeGate.started;
  await page.getByLabel("Route ID", { exact: true }).fill("unknown-route-b");
  routeGate.open();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => {
    const control = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save route");
    return control instanceof HTMLButtonElement && !control.disabled;
  });

  // Then reconciliation preserves and unlocks the newer route draft.
  assert.equal(await page.getByLabel("Route ID", { exact: true }).inputValue(), "unknown-route-b");
  assert.equal(await page.getByRole("button", { name: "Save route", exact: true }).isEnabled(), true);
  assert.equal(new Set(submittedAccountIds).size, submittedAccountIds.length - 1);
  for (const id of submittedAccountIds) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(fixture.inferenceRequests(), 0);
  process.stdout.write("API credentials and route drafts are revision-safe across known and reconciled completions.\n");
} finally {
  await browser.close();
  await fixture.close();
}
