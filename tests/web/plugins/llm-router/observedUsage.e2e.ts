import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { defaultLimits } from "../../../../packages/control-plane/plugins/llm-router/src/config.js";
import { llmWebFixture } from "./fixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM is required");
const fixture = await llmWebFixture();
const token = fixture.router.ledger.issue({ id: crypto.randomUUID(), name: "Accounting fixture" }, "default", "example", "accounting-fixture");
const grant = fixture.router.ledger.authenticate(token);
if (!grant) throw new Error("Missing fixture grant");
const ids = Array.from({ length: 2 }, () => {
  const request = fixture.router.ledger.reserve(grant, "model-one", fixture.router.ledger.project("example").revision, 0, defaultLimits, { accountId: "account-one" });
  fixture.router.ledger.dispatch(request.id);
  fixture.router.ledger.finish(request.id, { outcome: "uncertain", captureComplete: false });
  return request.id;
});
const [observedId, unknownId] = ids;
assert(observedId && unknownId);
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let resolutions = 0;
  page.on("request", (request) => { if (request.url().endsWith("/operations/request.resolve")) resolutions++; });
  await page.goto(fixture.origin);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "LLM router", exact: true }).click();
  await page.getByRole("link", { name: "Traffic & access", exact: true }).click();
  const observed = page.locator("article").filter({ hasText: `Request ${observedId}` });
  await observed.getByLabel("Observed input tokens", { exact: true }).fill("11");
  await observed.getByRole("button", { name: "Resolve outcome", exact: true }).click();
  await observed.getByText("Enter both observed token counts, or leave both blank.", { exact: true }).waitFor();
  assert.equal(resolutions, 0);
  await observed.getByLabel("Observed output tokens", { exact: true }).fill("3");
  page.once("dialog", (dialog) => dialog.accept());
  await observed.getByRole("button", { name: "Resolve outcome", exact: true }).click();
  await observed.getByText(/Execution operator_resolved/).waitFor();
  const saved = fixture.router.ledger.request(observedId);
  assert.equal(saved.input_tokens, 11);
  assert.equal(saved.output_tokens, 3);
  assert.equal(saved.occupied, 0);
  assert.equal(saved.accounting, "settled");

  const unknown = page.locator("article").filter({ hasText: `Request ${unknownId}` });
  page.once("dialog", (dialog) => dialog.accept());
  await unknown.getByRole("button", { name: "Resolve outcome", exact: true }).click();
  await unknown.getByText(/Execution operator_resolved/).waitFor();
  const retained = fixture.router.ledger.request(unknownId);
  assert.equal(retained.input_tokens, null);
  assert.equal(retained.output_tokens, null);
  assert.equal(retained.accounting, "reconciliation_required");
  assert.equal(retained.occupied, 0);
  assert.equal(resolutions, 2);
  await unknown.getByRole("button", { name: "Record usage", exact: true }).click();
  await unknown.getByText("Enter both observed token counts.", { exact: true }).waitFor();
  assert.equal(resolutions, 2);
  await unknown.getByLabel("Observed input tokens", { exact: true }).fill("5");
  await unknown.getByLabel("Observed output tokens", { exact: true }).fill("2");
  page.once("dialog", (dialog) => dialog.accept());
  await unknown.getByRole("button", { name: "Record usage", exact: true }).click();
  await unknown.getByText(/Usage settled/).waitFor();
  const corrected = fixture.router.ledger.request(unknownId);
  assert.equal(corrected.input_tokens, 5);
  assert.equal(corrected.output_tokens, 2);
  assert.equal(corrected.accounting, "settled");
  assert.equal(resolutions, 3);
  assert.equal(fixture.inferenceRequests(), 0);
  await unknown.getByText("Request metadata", { exact: true }).click();
  await unknown.locator(".llm-metadata").getByText("5", { exact: true }).waitFor();
  await unknown.locator(".llm-metadata").getByText("2", { exact: true }).waitFor();
  if (process.env.DIM_WEB_EVIDENCE) {
    await mkdir(process.env.DIM_WEB_EVIDENCE, { recursive: true });
    for (const width of [1280, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await unknown.screenshot({ path: `${process.env.DIM_WEB_EVIDENCE}/real-observed-usage-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  console.log("Real router observed accounting and retained unknown usage PASS; no inference replay");
} finally { await browser.close(); await fixture.close(); }
