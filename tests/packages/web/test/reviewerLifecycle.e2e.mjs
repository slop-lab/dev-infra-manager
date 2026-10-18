// @ts-check
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  reviewerWebFixture,
  WEB_PASSWORD,
  WEB_USERNAME
} from "./webHarness.js";
import { objectArrayField, readJsonObject, reviewPath } from "./httpFixture.js";

const playwrightPath = process.env.DIM_PLAYWRIGHT_CORE;
if (playwrightPath === undefined) {
  throw new Error("DIM_PLAYWRIGHT_CORE must name playwright-core/index.mjs");
}
const moduleUrl = pathToFileURL(playwrightPath);
/** @type {unknown} */
const metadata = JSON.parse(await readFile(new URL("./package.json", moduleUrl), "utf8"));
if (typeof metadata !== "object" || metadata === null || !("version" in metadata) || metadata.version !== "1.64.1") {
  throw new Error("The browser regression requires playwright-core 1.64.1, matching its checked API types");
}
/** @type {unknown} */
const loaded = await import(moduleUrl.href);
if (typeof loaded !== "object" || loaded === null || !("chromium" in loaded)
  || typeof loaded.chromium !== "object" || loaded.chromium === null
  || !("launch" in loaded.chromium) || typeof loaded.chromium.launch !== "function") {
  throw new Error("DIM_PLAYWRIGHT_CORE did not export the Chromium launch API");
}
// The supplied package version and the only consumed entrypoint are checked above.
const chromium = /** @type {Pick<import("playwright-core").BrowserType, "launch">} */ (loaded.chromium);
const READ_ONLY_USERNAME = "read-only-reviewer";
const fixture = await reviewerWebFixture({ accounts: [WEB_USERNAME, READ_ONLY_USERNAME], reviewerAccountId: WEB_USERNAME });
const browser = await chromium.launch({
  executablePath: process.env.DIM_CHROMIUM ?? "/usr/bin/google-chrome",
  headless: true
});
const page = await browser.newPage();
/** @type {string[]} */
const pageErrors = [];
page.on("pageerror", (error) => { pageErrors.push(error.message); console.error(error.message); });

try {
  // Given
  const login = async (username = WEB_USERNAME) => {
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(WEB_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.locator("#workspace").waitFor({ state: "visible" });
  };
  const openReview = async () => {
    await page.getByLabel("Review ID").fill(fixture.reviewId);
    await page.getByRole("button", { name: "Open review" }).click();
    await page.locator("#review-view").waitFor({ state: "visible" });
    assert.ok(((await page.locator("#patch-code").textContent()) ?? "").length > 0);
  };
  const expectEmptyReview = async () => {
    await page.locator("#empty-state").waitFor({ state: "visible" });
    assert.equal(await page.locator("#review-view").isHidden(), true);
    assert.equal(await page.locator("#retry-button").isHidden(), true);
    assert.equal(await page.locator("#patch-code").textContent(), "");
    assert.equal(await page.locator("#review-id").inputValue(), "");
    assert.equal(await page.locator("#proposal-ref").inputValue(), "");
    assert.equal(await page.locator("#review-metadata").textContent(), "");
    assert.equal(await page.locator("#changed-paths").textContent(), "");
    assert.equal(await page.locator("#stale-reasons").textContent(), "");
  };

  await page.goto(fixture.baseUrl);
  await page.locator("#login-view").waitFor({ state: "visible" });
  await login();
  await page.getByLabel("Proposal ref").fill(fixture.native.proposalRef);
  await page.getByRole("button", { name: "Find and open" }).click();
  await page.locator("#review-view").waitFor({ state: "visible" });
  assert.equal(await page.locator("#review-id").inputValue(), fixture.reviewId);
  assert.ok(((await page.locator("#patch-code").textContent()) ?? "").length > 0);

  const { promise: approvalReleased, resolve: releaseApproval } = deferred();
  const { promise: approvalCommitted, resolve: markApprovalCommitted } = deferred();
  const approvalPath = `/v1/projects/project-a/repositories/root/reviews/${fixture.reviewId}/approvals`;
  await page.route(`**${approvalPath}`, async (route) => {
    const response = await route.fetch();
    markApprovalCommitted();
    await approvalReleased;
    await route.fulfill({ response });
  });

  // When
  await page.getByRole("button", { name: "Approve review" }).click();
  await approvalCommitted;
  const authoritative = await fixture.native.request("reviewer-a-user", "GET", reviewPath(`/${fixture.reviewId}`));
  await page.locator("#open-form").evaluate((form) => {
    if (!(form instanceof HTMLFormElement)) throw new Error("Open review form is missing");
    form.requestSubmit();
  });

  // Then
  assert.equal(objectArrayField(await readJsonObject(authoritative), "approvals").length, 1);
  assert.equal(await page.locator("#open-button").isDisabled(), true);
  assert.equal(await page.locator("#logout-button").isDisabled(), true);
  assert.equal(await page.locator("#review-id").isDisabled(), true);
  assert.equal(await page.locator("#decision-status").textContent(), "You have not approved this exact review.");
  releaseApproval();
  await page.getByRole("button", { name: "Revoke approval" }).waitFor({ state: "visible" });
  await page.unroute(`**${approvalPath}`);
  assert.equal(await page.locator("#review-status").textContent(), "Approved");
  assert.equal(await page.locator("#decision-status").textContent(), "Your approval is recorded for this exact review.");

  // When
  await page.getByRole("button", { name: "Revoke approval" }).click();

  // Then
  await page.getByRole("button", { name: "Approve review" }).waitFor({ state: "visible" });
  assert.equal(await page.locator("#review-status").textContent(), "Revoked");
  assert.equal(await page.locator("#decision-status").textContent(), "Your approval has been revoked.");

  // When
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.locator("#login-view").waitFor({ state: "visible" });
  await login(READ_ONLY_USERNAME);
  await openReview();
  const bobStatuses = await page.evaluate(async (path) => {
    /** @type {unknown} */
    const activeSession = await fetch("/v1/session").then((response) => response.json());
    if (typeof activeSession !== "object" || activeSession === null
      || !("csrfToken" in activeSession) || typeof activeSession.csrfToken !== "string") throw new Error("Missing browser session token");
    const csrfToken = activeSession.csrfToken;
    return Promise.all(["approvals", "revocations"].map(async (action) => (await fetch(`${path}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-DIM-CSRF": csrfToken },
      body: "{}"
    })).status));
  }, `/v1/projects/project-a/repositories/root/reviews/${fixture.reviewId}`);

  // Then
  assert.deepEqual(bobStatuses, [403, 403]);
  assert.equal(await page.getByRole("button", { name: "Approve review" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Revoke approval" }).count(), 0);
  assert.equal(await page.locator("#decision-status").textContent(), "This account can inspect evidence but cannot record a review decision.");

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.locator("#login-view").waitFor({ state: "visible" });
  await login();
  await expectEmptyReview();

  await page.getByLabel("Proposal ref").fill("refs/heads/private-proposal");

  // When
  await page.getByRole("button", { name: "Sign out" }).click();

  // Then
  await page.locator("#login-view").waitFor({ state: "visible" });
  await login();
  await expectEmptyReview();

  // When
  await openReview();
  fixture.now.value += 10_001;
  await page.getByRole("button", { name: "Open review" }).click();

  // Then
  await page.locator("#login-view").waitFor({ state: "visible" });
  assert.equal(await page.locator("#login-error").textContent(), "Your session ended. Sign in again.");
  await login();
  await expectEmptyReview();

  const reviewMemberPath = `/v1/projects/project-a/repositories/root/reviews/${fixture.reviewId}`;
  const reviewBody = await page.evaluate(async (path) => (await fetch(path)).text(), reviewMemberPath);
  const { promise: reviewReleased, resolve: releaseReview } = deferred();
  const { promise: routeStarted, resolve: markRouteStarted } = deferred();
  const { promise: routeFinished, resolve: markRouteFinished } = deferred();
  await page.route(`**${reviewMemberPath}`, async (route) => {
    markRouteStarted();
    await reviewReleased;
    await route.fulfill({ status: 200, contentType: "application/json", body: reviewBody }).catch(() => undefined);
    markRouteFinished();
  });

  // When
  await page.getByLabel("Review ID").fill(fixture.reviewId);
  await page.getByRole("button", { name: "Open review" }).click();
  await routeStarted;
  await page.locator("#loading-state").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.locator("#login-view").waitFor({ state: "visible" });
  await login();
  releaseReview();
  await routeFinished;

  // Then
  await expectEmptyReview();

  // Given
  await page.setViewportSize({ width: 900, height: 600 });
  await openReview();
  await page.locator(".context-rail").evaluate((element) => element.scrollTo({ top: 0 }));
  const railBefore = await page.locator(".context-rail").evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop
  }));

  // When
  await page.locator(".context-rail").evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  const railAfter = await page.locator(".context-rail").evaluate((element) => ({
    scrollTop: element.scrollTop,
    openButtonBottom: document.querySelector("#open-button")?.getBoundingClientRect().bottom ?? Infinity
  }));
  await page.locator("#proposal-ref").focus();
  const tabOrder = [];
  for (let step = 0; step < 3; step += 1) {
    await page.keyboard.press("Tab");
    tabOrder.push(await page.evaluate(() => document.activeElement?.id ?? ""));
  }

  // Then
  assert.equal(railBefore.overflowY, "auto");
  assert.ok(railBefore.scrollHeight > railBefore.clientHeight);
  assert.equal(railBefore.scrollTop, 0);
  assert.ok(railAfter.scrollTop > 0);
  assert.ok(railAfter.openButtonBottom <= 600);
  assert.deepEqual(tabOrder, ["create-button", "review-id", "open-button"]);

  // When
  await page.setViewportSize({ width: 720, height: 900 });
  const metadataColumns = await page.locator("#review-metadata").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);

  // Then
  assert.equal(metadataColumns, 1);
  assert.deepEqual(pageErrors, []);
} finally {
  await browser.close();
  await fixture.close();
}

/** @returns {{promise: Promise<void>, resolve: () => void}} */
function deferred() {
  /** @type {() => void} */
  let resolve = () => { throw new Error("Deferred promise was not initialized"); };
  const promise = new Promise((done) => { resolve = () => done(undefined); });
  return { promise, resolve };
}
