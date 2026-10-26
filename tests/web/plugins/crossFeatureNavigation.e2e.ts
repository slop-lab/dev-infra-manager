import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { createServicePanelsFixture } from "./servicePanelsFixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const fixture = await createServicePanelsFixture();
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(10_000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = process.env.DIM_WEB_EVIDENCE;
if (evidence) await mkdir(evidence, { recursive: true });
let creates = 0;
page.on("request", (request) => { if (request.url().endsWith("/workspaces/create")) creates++; });
async function capture(name: string) {
  if (!evidence) return;
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const state = await page.evaluate(() => {
      const link = document.querySelector(".skip-link");
      const rect = link?.getBoundingClientRect();
      return { scrollY: window.scrollY, activeTag: document.activeElement?.tagName, activeLabel: document.activeElement?.getAttribute("aria-label"), skipFocused: link === document.activeElement,
        skipFocusVisible: link?.matches(":focus-visible"), skipTop: rect?.top, skipBottom: rect?.bottom, skipTransform: link ? getComputedStyle(link).transform : null };
    });
    await writeFile(`${evidence}/${name}-${width}.json`, JSON.stringify(state, null, 2));
    await page.screenshot({ path: `${evidence}/${name}-${width}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

try {
  await page.goto(fixture.origin);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Git review", exact: true }).click();
  const git = page.locator(".feature-page").filter({ has: page.getByRole("heading", { name: "Git review", exact: true, level: 1 }) });
  await git.getByLabel("Repository", { exact: true }).selectOption("root");
  const invalidGitTarget = await page.evaluate(`import('/assets/navigation-broker.js').then(({ navigation }) => navigation.openFeature('native-git', { kind: 'repository', controllerKey: 'devbox', projectId: 'project-a', repositoryId: 'root', extra: true }))`);
  assert.deepEqual(invalidGitTarget, { status: "unavailable", code: "invalid-target", message: "The navigation target is invalid." });
  const missingGitTarget = await page.evaluate(`import('/assets/navigation-broker.js').then(({ navigation }) => navigation.openFeature('native-git', { kind: 'repository', controllerKey: 'missing', projectId: 'project-a', repositoryId: 'root' }))`);
  assert.deepEqual(missingGitTarget, { status: "unavailable", code: "target-unavailable", message: "The requested Git target is unavailable." });
  assert.equal(await git.getByLabel("Git connection", { exact: true }).inputValue(), "devbox");
  const reviewTarget = await page.evaluate(`import('/assets/navigation-broker.js').then(({ navigation }) => navigation.openFeature('native-git', { kind: 'review', controllerKey: 'devbox', projectId: 'project-a', repositoryId: 'root', reviewId: ${JSON.stringify(fixture.reviewId)} }))`);
  assert.deepEqual(reviewTarget, { status: "opened", message: `Opened review ${fixture.reviewId}.` });
  await git.getByRole("heading", { name: "Changed files", exact: true }).waitFor();
  await capture("git-review-navigation");
  let releaseReviewDetail: () => void = () => {}, markReviewDetail: () => void = () => {};
  const reviewDetailGate = new Promise<void>((resolve) => { releaseReviewDetail = resolve; });
  const reviewDetailStarted = new Promise<void>((resolve) => { markReviewDetail = resolve; });
  await page.route("**/v1/extensions/native-git/operations/reviews.detail", async (route) => {
    const response = await route.fetch(); markReviewDetail(); await reviewDetailGate; await route.fulfill({ response });
  }, { times: 1 });
  const heldReviewTarget = page.evaluate(`import('/assets/navigation-broker.js').then(({ navigation }) => navigation.openFeature('native-git', { kind: 'review', controllerKey: 'devbox', projectId: 'project-a', repositoryId: 'root', reviewId: ${JSON.stringify(fixture.reviewId)} }))`);
  await reviewDetailStarted;
  await git.getByLabel("Git connection", { exact: true }).selectOption("otherbox");
  await git.getByRole("button", { name: "Open review", exact: true }).waitFor();
  releaseReviewDetail();
  assert.deepEqual(await heldReviewTarget, { status: "unavailable", code: "target-unavailable", message: "The requested Git target is unavailable." });
  assert.equal(await git.getByLabel("Git connection", { exact: true }).inputValue(), "otherbox");
  await page.unroute("**/v1/extensions/native-git/operations/reviews.detail");
  await git.getByLabel("Git connection", { exact: true }).selectOption("devbox");
  await git.getByLabel("Repository", { exact: true }).selectOption("root");
  await git.getByRole("button", { name: "View execution jobs", exact: true }).click();
  const execution = page.locator(".feature-page").filter({ has: page.getByRole("heading", { name: "Execution", exact: true, level: 1 }) });
  await execution.getByText("Showing jobs for project-a/root.", { exact: true }).waitFor();
  await execution.getByRole("button", { name: "View worker job", exact: true }).click();
  await execution.getByRole("heading", { name: "worker-current — assigned", exact: true }).waitFor();
  await capture("execution-worker-detail");
  await execution.getByRole("button", { name: "Open repository reviews", exact: true }).click();
  await git.getByText("Git connection: devbox · project-a/root.", { exact: true }).waitFor();
  assert.equal(await git.getByLabel("Git connection", { exact: true }).inputValue(), "devbox");
  assert.equal(await git.getByLabel("Project", { exact: true }).inputValue(), "project-a");
  assert.equal(await git.getByLabel("Repository", { exact: true }).inputValue(), "root");
  await git.getByRole("button", { name: "Create managed workspace", exact: true }).click();
  await page.getByLabel("Git URL or dim://PROJECT on devbox", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Git URL or dim://PROJECT on devbox", { exact: true }).inputValue(), "dim://project-alias");
  assert.equal(await page.getByLabel("Managed repositories (comma separated, optional) on devbox", { exact: true }).inputValue(), "root");
  assert.equal(await page.getByLabel("Managed working repository (optional) on devbox", { exact: true }).inputValue(), "root");
  assert.equal(creates, 0);
  await capture("managed-workspace-draft");
  await page.getByRole("button", { name: "Git review", exact: true }).click();
  await git.getByRole("button", { name: "Create workspace with all repositories", exact: true }).click();
  assert.equal(await page.getByLabel("Managed repositories (comma separated, optional) on devbox", { exact: true }).inputValue(), "root, private");
  assert.equal(await page.getByLabel("Managed working repository (optional) on devbox", { exact: true }).inputValue(), "root");
  assert.equal(creates, 0);
  await page.route("**/v1/extensions/native-git/operations/projects.list", (route) => route.fulfill({ status: 503, json: { error: "initial discovery unavailable" } }), { times: 1 });
  await page.reload();
  await page.getByRole("button", { name: "Git review", exact: true }).click();
  await git.getByText(/^Could not discover projects:/).waitFor();
  await git.getByRole("button", { name: "Refresh projects", exact: true }).click();
  await git.getByRole("heading", { name: "Merge a branch", exact: true }).waitFor();
  const advanced = git.getByText("Advanced: exact reviews and upstream sync", { exact: true });
  if (!await advanced.evaluate(node => node.parentElement instanceof HTMLDetailsElement && node.parentElement.open)) await advanced.click();
  await git.getByRole("button", { name: "Open review", exact: true }).waitFor();
  const recoveredTarget = await page.evaluate(`import('/assets/navigation-broker.js').then(({ navigation }) => navigation.openFeature('native-git', { kind: 'repository', controllerKey: 'devbox', projectId: 'project-a', repositoryId: 'root' }))`);
  assert.deepEqual(recoveredTarget, { status: "opened", message: "Opened project-a/root reviews." });
  assert.deepEqual(errors, []);
  process.stdout.write("Scoped Git and execution navigation passed.\n");
} finally {
  await browser.close();
  await fixture.close();
}
