import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import {createBrowserEvidence} from './browserEvidence.js';
import { defaultLimits } from "../../../../packages/control-plane/plugins/llm-router/src/config.js";
import { llmWebFixture } from "./fixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM is required");

const fixture = await llmWebFixture();
fixture.router.ledger.createProject("other", { allowedRoutes: ["default"], limits: defaultLimits, captureMode: "required", tokenMode: "observe" });
fixture.router.ledger.issue({ id: "workspace-example", name: "Example workspace" }, "default", "example", "principal-example");
fixture.router.ledger.issue({ id: "workspace-other", name: "Other workspace" }, "default", "other", "principal-other");

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const evidence = createBrowserEvidence(page);

  const request = (id: string, projectId: string) => ({
    id,
    project_id: projectId,
    principal_id: `principal-${projectId}`,
    account_id: "account-one",
    started_at: 1_700_000_000_000,
    finished_at: 1_700_000_001_000,
    model: "model-one",
    outcome: "uncertain",
    execution: "outcome_unknown",
    delivery: "partial",
    accounting: "reconciliation_required",
    occupied: 1,
    cancel_requested: 0,
    input_tokens: null,
    output_tokens: null,
    error_code: "router-restarted",
  });
  const requests = [
    request("10000000-0000-4000-8000-000000000001", "example"),
    request("20000000-0000-4000-8000-000000000002", "example"),
    request("30000000-0000-4000-8000-000000000003", "example"),
    request("40000000-0000-4000-8000-000000000004", "other"),
    request("50000000-0000-4000-8000-000000000005", "missing"),
    request("60000000-0000-4000-8000-000000000006", "Invalid Project"),
    request("70000000-0000-4000-8000-000000000007", "example"),
    request("80000000-0000-4000-8000-000000000008", "example"),
  ];
  const resolutions: Array<Record<string, unknown>> = [];
  let failRetry = true;
  let rejectKnown = true;
  let loseAcceptedResponse = true;
  let failRequests = false;
  let loseCancellationResponse = true;
  let cancellations = 0;
  let principalRevocations = 0;
  await page.route("**/v1/extensions/llm-router/operations/requests", async (route) => {
    if (failRequests) { failRequests = false; await route.fulfill({ status: 503, json: { error: "simulated requests failure" } }); return; }
    await route.fulfill({ json: requests });
  });
  await page.route("**/v1/extensions/llm-router/operations/request.resolve", async (route) => {
    const input = route.request().postDataJSON() as Record<string, unknown>;
    if (input.requestId === requests[2]?.id && failRetry) {
      failRetry = false;
      await route.fulfill({ status: 503, json: { error: "simulated resolution failure" } });
      return;
    }
    if (input.requestId === requests[6]?.id && rejectKnown) {
      rejectKnown = false;
      await route.fulfill({ status: 400, json: { error: "simulated known rejection" } });
      return;
    }
    if (input.requestId === requests[7]?.id && loseAcceptedResponse) {
      loseAcceptedResponse = false;
      resolutions.push(input);
      Object.assign(requests[7] ?? {}, { execution: "operator_resolved", accounting: "settled", occupied: 0, input_tokens: 7, output_tokens: 1 });
      await route.fulfill({ status: 503, json: { error: "simulated lost accepted response" } });
      return;
    }
    resolutions.push(input);
    await route.fulfill({ json: { resolved: true } });
  });
  await page.route("**/v1/extensions/llm-router/operations/request.cancel", async (route) => {
    cancellations++;
    const input = route.request().postDataJSON() as { requestId: string };
    const request = requests.find(({ id }) => id === input.requestId);
    if (request) request.cancel_requested = 1;
    if (loseCancellationResponse) { loseCancellationResponse = false; await route.fulfill({ status: 503, json: { error: "simulated lost accepted response" } }); }
    else await route.fulfill({ json: { cancellationRequested: true, upstreamTerminationConfirmed: false } });
  });
  await page.route("**/v1/extensions/llm-router/operations/principal.revoke", async (route) => { principalRevocations++; const response = await route.fetch(); await route.fulfill({ response, status: 503, json: { error: "simulated lost accepted response" } }); }, { times: 1 });

  await page.goto(fixture.origin);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "LLM router", exact: true }).click();
  await page.getByRole("link", { name: "Projects & policy", exact: true }).click();
  await page.getByRole("link", { name: "example", exact: true }).click();
  await page.getByRole("heading", { name: "Project example", exact: true }).waitFor();

  await page.getByLabel("Requests per UTC day", { exact: true }).fill("79");
  await page.getByRole("link", { name: "Traffic & access", exact: true }).click();
  const currentRequest = page.locator("article").filter({ hasText: `Request ${requests[0]?.id}` });
  await currentRequest.getByRole("button", { name: "Open routing project example", exact: true }).click();
  await page.waitForURL(/#\/features\/llm-router\/projects\/example$/);
  await page.getByRole("heading", { name: "Project example", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Requests per UTC day", { exact: true }).inputValue(), "79");
  await evidence("current-project-focus", currentRequest);

  await page.getByRole("link", { name: "Traffic & access", exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  const otherRequest = page.locator("article").filter({ hasText: `Request ${requests[3]?.id}` });
  await otherRequest.getByRole("button", { name: "Open routing project other", exact: true }).click();
  await otherRequest.getByText("Kept unsaved routing policy changes for example.", { exact: true }).waitFor();
  await page.waitForURL(/#\/features\/llm-router\/traffic$/);
  assert.equal(await page.getByRole("heading", { name: "Project example", exact: true }).isVisible(), false);
  assert.equal(await page.getByLabel("Requests per UTC day", { exact: true }).inputValue(), "79");
  await evidence("dirty-navigation-blocked", otherRequest);

  await page.getByRole("button", { name: "Open routing project missing", exact: true }).click();
  await page.getByText("Routing project missing is not available.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Project example", exact: true }).isVisible(), false);
  await evidence("missing-project-unavailable", page.locator("article").filter({ hasText: `Request ${requests[4]?.id}` }));
  await page.getByRole("button", { name: "Open routing project Invalid Project", exact: true }).click();
  await page.getByText("The routing project target is invalid.", { exact: true }).waitFor();

  const observed = page.locator("article").filter({ hasText: `Request ${requests[0]?.id}` });
  await observed.getByRole("button", { name: "Request cancellation", exact: true }).click();
  await observed.getByRole("alert").waitFor();
  assert.equal(await observed.getByRole("button", { name: "Request cancellation", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent === 'Refresh router' && !button.disabled));
  assert.equal(await observed.getByRole("button", { name: "Request cancellation", exact: true }).isDisabled(), true);
  assert.equal(cancellations, 1);
  await observed.getByLabel("Observed input tokens", { exact: true }).fill("123");
  await observed.getByLabel("Observed output tokens", { exact: true }).fill("45");
  failRequests = true;
  page.once("dialog", (dialog) => dialog.accept());
  await observed.getByRole("button", { name: "Resolve outcome", exact: true }).click();
  const acceptedReadFailed = page.getByText("Resolution recorded with observed token usage for request 10000000-0000-4000-8000-000000000001. Latest recent requests could not refresh. Use Refresh router to read the current state; the resolution was accepted.", { exact: true });
  await acceptedReadFailed.waitFor();
  assert.equal(await observed.getByRole("button", { name: "Resolve outcome", exact: true }).isDisabled(), true);
  assert.deepEqual(resolutions[0], { requestId: requests[0]?.id, usage: { inputTokens: 123, outputTokens: 45 } });
  await acceptedReadFailed.scrollIntoViewIfNeeded();
  await evidence("resolution-accepted-read-failed");
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Refresh router" && !button.disabled));

  const noUsage = page.locator("article").filter({ hasText: `Request ${requests[1]?.id}` });
  page.once("dialog", (dialog) => dialog.accept());
  await noUsage.getByRole("button", { name: "Resolve outcome", exact: true }).click();
  await page.getByText(`Resolution recorded without observed token usage for request ${requests[1]?.id}.`, { exact: true }).waitFor();
  await noUsage.getByText("Resolution was accepted. Refresh current state before another mutation.", { exact: true }).waitFor();
  assert.deepEqual(resolutions[1], { requestId: requests[1]?.id });
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Refresh router" && !button.disabled));
  const staleAccepted = page.locator("article").filter({ hasText: `Request ${requests[1]?.id}` });
  await staleAccepted.getByText("Resolution was accepted. Refresh current state before another mutation.", { exact: true }).waitFor();

  const retry = page.locator("article").filter({ hasText: `Request ${requests[2]?.id}` });
  await retry.getByLabel("Observed input tokens", { exact: true }).fill("8");
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Refresh router" && !button.disabled));
  const refreshedRetry = page.locator("article").filter({ hasText: `Request ${requests[2]?.id}` });
  assert.equal(await refreshedRetry.getByLabel("Observed input tokens", { exact: true }).inputValue(), "8");
  await refreshedRetry.getByLabel("Observed output tokens", { exact: true }).fill("3");
  page.once("dialog", (dialog) => dialog.accept());
  await refreshedRetry.getByRole("button", { name: "Resolve outcome", exact: true }).click();
  await refreshedRetry.getByRole("alert").waitFor();
  assert.equal(await refreshedRetry.getByLabel("Observed input tokens", { exact: true }).inputValue(), "8");
  assert.equal(await refreshedRetry.getByLabel("Observed output tokens", { exact: true }).inputValue(), "3");
  assert.equal(await refreshedRetry.getByRole("button", { name: "Resolve outcome", exact: true }).isDisabled(), true);
  await evidence("resolution-failed-draft-kept", refreshedRetry);
  failRequests = true;
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Refresh router" && !button.disabled));
  assert.equal(await refreshedRetry.getByRole("button", { name: "Resolve outcome", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Refresh router" && !button.disabled));
  let reconciledRetry = page.locator("article").filter({ hasText: `Request ${requests[2]?.id}` });
  assert.equal(await reconciledRetry.getByLabel("Observed input tokens", { exact: true }).inputValue(), "8");
  assert.equal(await reconciledRetry.getByLabel("Observed output tokens", { exact: true }).inputValue(), "3");
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Refresh router" && !button.disabled));
  reconciledRetry = page.locator("article").filter({ hasText: `Request ${requests[2]?.id}` });
  assert.equal(await reconciledRetry.getByLabel("Observed input tokens", { exact: true }).inputValue(), "8");
  assert.equal(await reconciledRetry.getByLabel("Observed output tokens", { exact: true }).inputValue(), "3");
  page.once("dialog", (dialog) => dialog.accept());
  await reconciledRetry.getByRole("button", { name: "Resolve outcome", exact: true }).click();
  await reconciledRetry.getByText("Resolution was accepted. Refresh current state before another mutation.", { exact: true }).waitFor();
  assert.deepEqual(resolutions[2], { requestId: requests[2]?.id, usage: { inputTokens: 8, outputTokens: 3 } });

  const invalid = page.locator("article").filter({ hasText: `Request ${requests[3]?.id}` });
  await invalid.getByLabel("Observed input tokens", { exact: true }).fill("1");
  await invalid.getByRole("button", { name: "Resolve outcome", exact: true }).click();
  await invalid.getByText("Enter both observed token counts, or leave both blank.", { exact: true }).waitFor();
  assert.equal(resolutions.length, 3);
  await evidence("resolution-partial-invalid", invalid);

  const rejected = page.locator("article").filter({ hasText: `Request ${requests[6]?.id}` });
  await rejected.getByLabel("Observed input tokens", { exact: true }).fill("6");
  await rejected.getByLabel("Observed output tokens", { exact: true }).fill("4");
  page.once("dialog", (dialog) => dialog.accept());
  await rejected.getByRole("button", { name: "Resolve outcome", exact: true }).click();
  await rejected.getByRole("alert").waitFor();
  assert.equal(await rejected.getByRole("button", { name: "Resolve outcome", exact: true }).isEnabled(), true);
  page.once("dialog", (dialog) => dialog.accept());
  await rejected.getByRole("button", { name: "Resolve outcome", exact: true }).click();
  await rejected.getByText("Resolution was accepted. Refresh current state before another mutation.", { exact: true }).waitFor();
  assert.deepEqual(resolutions[3], { requestId: requests[6]?.id, usage: { inputTokens: 6, outputTokens: 4 } });

  const lost = page.locator("article").filter({ hasText: `Request ${requests[7]?.id}` });
  await lost.getByLabel("Observed input tokens", { exact: true }).fill("7");
  await lost.getByLabel("Observed output tokens", { exact: true }).fill("1");
  page.once("dialog", (dialog) => dialog.accept());
  await lost.getByRole("button", { name: "Resolve outcome", exact: true }).click();
  await lost.getByRole("alert").waitFor();
  assert.equal(await lost.getByRole("button", { name: "Resolve outcome", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Refresh router" && !button.disabled));
  const acceptedAfterLoss = page.locator("article").filter({ hasText: `Request ${requests[7]?.id}` });
  await acceptedAfterLoss.getByText(/Execution operator_resolved/).waitFor();
  assert.equal(await acceptedAfterLoss.getByRole("button", { name: /Resolve outcome/ }).count(), 0);
  assert.equal(resolutions.filter((input) => input.requestId === requests[7]?.id).length, 1);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revoke Example workspace", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Revoke Example workspace", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  assert.equal(principalRevocations, 1);

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill("observer");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "LLM router", exact: true }).click();
  await page.getByRole("heading", { name: "Accounts & routes", exact: true }).waitFor();
  await page.getByRole("link", { name: "Traffic & access", exact: true }).click();
  assert.equal(await page.getByLabel("Observed input tokens", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /Resolve outcome/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /Request cancellation/ }).count(), 0);
  await page.getByRole("heading", { name: "Recent requests", exact: true }).scrollIntoViewIfNeeded();
  await evidence("read-only-no-resolution-controls");
  await page.route("**/v1/extensions/llm-router/operations/overview", (route) => route.fulfill({ status: 503, json: { error: "initial router unavailable" } }), { times: 1 });
  await page.reload();
  await page.getByRole("link", { name: "LLM router", exact: true }).click();
  await page.getByRole("button", { name: "Refresh router", exact: true }).waitFor();
  await page.getByText(/The operation did not return a reliable outcome/).waitFor();
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.getByRole("link", { name: "Projects & policy", exact: true }).click();
  await page.getByRole("link", { name: "example", exact: true }).waitFor();
  await page.getByRole("link", { name: "example", exact: true }).click();
  await page.getByRole("heading", { name: "Project example", exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("LLM router navigation and unknown-request observed accounting PASS");
} finally {
  await browser.close();
  await fixture.close();
}
