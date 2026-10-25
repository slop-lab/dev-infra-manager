import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { nativeRepositoryPolicyRevision } from "@slop-lab/dim-contracts-git";
import { controlPlanePlugin as mergePlugin } from "@slop-lab/dim-control-plane-plugin-git-merge-policy";
import { controlPlanePlugin as syncPlugin } from "@slop-lab/dim-control-plane-plugin-git-sync";
import { basic, fixture, generationId, git, record, reviewer, text, token } from "../../control-plane/plugins/git-repositories/optionalFeaturesFixture.js";
import { initializeOperationsWeb } from "../../../packages/web/core/src/initialize.js";
import { parseWebConfig } from "../../../packages/web/core/src/config.js";
import { createWebServerFromConfigFile } from "../../../packages/web/core/src/server.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const promoter = { hostId: "host-a", username: "promoter", password: token(10) };
const synchronizer = { hostId: "host-a", username: "synchronizer", password: token(11) };
const merge = await mergePlugin.configure({ hostPromoters: [promoter] });
const sync = await syncPlugin.configure({ operators: [synchronizer], allowLocalRemotes: true });
const reviewPolicy = { requiredReviewerIds: [], pathReviewerRules: [{ pathPrefix: "README.md", reviewerIds: ["owner"] }] };
const upstreamRoot = await mkdtemp(join(tmpdir(), "dim-web-publish-")), upstream = join(upstreamRoot, "upstream.git"), secondaryUpstream = join(upstreamRoot, "secondary.git");
await git("/usr/bin/git", ["init", "--bare", upstream]);
await git("/usr/bin/git", ["init", "--bare", secondaryUpstream]);
const syncPolicy = { upstream: { url: pathToFileURL(upstream).href, branch: "development" }, publish: { main: "development" } };
const secondarySyncPolicy = { upstream: { url: pathToFileURL(secondaryUpstream).href, branch: "development" }, publish: { main: "development" } };
const f = await fixture(true, [...(merge.extensions ?? []), ...(sync.extensions ?? [])], reviewPolicy, [reviewer], {
  "merge-policy": {}, "git-sync": syncPolicy
});
const headers = (credential: { username: string; password: string }) => ({ authorization: basic(credential), "x-dim-generation-id": generationId, "content-type": "application/json" });
const repositoryPath = f.origin + "/v1/projects/project/repositories/main";
const post = (suffix: string, body: unknown, credential: { username: string; password: string } = reviewer) => fetch(repositoryPath + suffix, { method: "POST", headers: headers(credential), body: JSON.stringify(body) });
let web: Awaited<ReturnType<typeof createWebServerFromConfigFile>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const importer = { username: "importer", password: token(1) };
  await f.service.prepareProject(generationId, "host-a", { serviceId: "native-main", projectId: "project", repositoryId: "secondary" });
  const secondaryBundle = join(f.root, "secondary.bundle");
  await git("/usr/bin/git", ["-C", f.source, "bundle", "create", secondaryBundle, "refs/heads/main"]);
  const secondaryExtensions = { "code-review": reviewPolicy, "merge-policy": {}, "git-sync": secondarySyncPolicy };
  const secondaryPolicy = { schemaVersion: 1, protectedRef: "refs/heads/main", defaultRef: "refs/heads/main", branches: { "refs/heads/main": { review: true }, "refs/heads/development": { review: false } }, extensions: secondaryExtensions };
  const secondaryPrelude = { schemaVersion: 1, serviceId: "native-main", generationId, projectId: "project", repositoryId: "secondary", protectedRef: "refs/heads/main", expectedCommit: f.initial,
    policy: { ...secondaryPolicy, policyRevision: nativeRepositoryPolicyRevision(secondaryPolicy) } };
  const secondaryImport = await fetch(f.origin + "/v1/projects/project/repositories/secondary/import", { method: "POST", headers: { authorization: basic(importer), "content-type": "application/octet-stream" },
    body: Buffer.concat([Buffer.from(`${JSON.stringify(secondaryPrelude)}\n`), await readFile(secondaryBundle)]) });
  assert.equal(secondaryImport.status, 200, await secondaryImport.clone().text());
  const secondaryReceipt = record(await secondaryImport.json());
  const secondaryFinalize = await fetch(f.origin + "/v1/projects/project/repositories/secondary/import/finalize", { method: "POST", headers: headers(importer), body: JSON.stringify({ schemaVersion: 1, generationId,
    importNonce: text(secondaryReceipt, "importNonce"), bundleDigest: text(secondaryReceipt, "bundleDigest") }) });
  assert.equal(secondaryFinalize.status, 200, await secondaryFinalize.clone().text());
  const previous = record(await (await fetch(repositoryPath + "/policy", { headers: headers(importer) })).json());
  const body = { protectedRef: "refs/heads/main", defaultRef: "refs/heads/main", branches: { "refs/heads/main": { review: true }, "refs/heads/development": { review: false } }, extensions: { "code-review": reviewPolicy, "merge-policy": {}, "git-sync": syncPolicy } };
  assert.equal((await post("/policy", { schemaVersion: 1, expectedPolicyDigest: previous.policyDigest, expectedProtectedHead: record(previous.currentHead).commit, policy: { schemaVersion: 1, ...body, policyRevision: nativeRepositoryPolicyRevision(body) } }, importer)).status, 200);
  await writeFile(join(f.source, "README.md"), "reviewed boundary change\n");
  const candidate = await f.commit();
  await git("/usr/bin/git", ["-C", f.source, "push", upstream, f.initial + ":refs/heads/development"]);
  await git("/usr/bin/git", ["-C", f.source, "push", "origin", "HEAD:" + f.proposalRef]);
  const development = await post("/reviews/resolve", { schemaVersion: 1, proposalRef: f.proposalRef, protectedRef: "refs/heads/development" });
  assert.equal(development.status, 200);
  const review = record(record(await development.json()).review);
  assert.deepEqual(review.requiredReviewerIds, []);
  assert.equal((await post("/reviews/" + text(review, "reviewId") + "/promotions", { schemaVersion: 1 }, promoter)).status, 201);
  const reviewerConnection = join(f.root, "reviewer.json"), promoterConnection = join(f.root, "promoter.json"), syncConnection = join(f.root, "git-sync.json");
  await writeFile(reviewerConnection, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", baseUrl: f.origin, generationId, ...reviewer }), { mode: 0o600 });
  await writeFile(promoterConnection, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", endpoint: f.origin, generationId, role: "host-promoter", hostId: promoter.hostId, credential: { username: promoter.username, password: promoter.password } }), { mode: 0o600 });
  await writeFile(syncConnection, JSON.stringify({ schemaVersion: 1, serviceId: "native-main", endpoint: f.origin, generationId, role: "git-sync-operator", hostId: synchronizer.hostId, credential: { username: synchronizer.username, password: synchronizer.password } }), { mode: 0o600 });
  const operations = join(f.root, "operations.json"), config = join(f.root, "web.json");
  await writeFile(operations, JSON.stringify({ hosts: [{ id: "devbox", selector: "fixture", executable: "/usr/bin/false" }] }), { mode: 0o600 });
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const login = await initializeOperationsWeb({ operations, output: config, port: address.port });
  const saved = parseWebConfig(JSON.parse(await readFile(config, "utf8")));
  await writeFile(config, JSON.stringify({ ...saved, accounts: saved.accounts.map((account) => ({ ...account, roles: ["read", "operator", "reviewer"] })), pluginHome: fileURLToPath(new URL("../../", import.meta.url)), plugins: [{ package: "@slop-lab/dim-web-plugin-native-git", config: { reviewerConnection, promoterConnection, syncConnection, projects: [{ projectId: "project", repositoryIds: ["main", "secondary"] }] } }] }), { mode: 0o600 });
  web = await createWebServerFromConfigFile(config);
  const origin = await web.listen();
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage(); page.setDefaultTimeout(20_000);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin); await page.getByLabel("Username", { exact: true }).fill(login.username); await page.getByLabel("Password", { exact: true }).fill(login.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("button", { name: "Git review", exact: true }).click();
  const fetchUpstream = page.getByRole("button", { name: "Fetch upstream", exact: true }); await fetchUpstream.click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Fetch upstream" && !button.disabled));
  assert.equal(await page.getByLabel("Merge source branch", { exact: true }).inputValue(), "development");
  assert.equal(await page.getByLabel("Merge target branch", { exact: true }).inputValue(), "main");
  await page.route("**/v1/extensions/native-git/operations/reviews.detail", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"temporary detail failure"}' }), { times: 1 });
  await page.getByRole("button", { name: "Create branch merge review", exact: true }).click();
  await page.getByText(/Branch merge review created\..*Latest review details could not refresh/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create branch merge review", exact: true }).isDisabled(), true);
  const repository = page.getByLabel("Repository", { exact: true });
  await repository.selectOption("secondary");
  await page.getByText(/Current repository target: .* · project\/secondary\./).waitFor();
  assert.equal(await page.locator("tr").filter({ hasText: "/merge/" }).count(), 0, "main repository review rows must not leak into secondary scope");
  assert.equal(await page.getByText(/Branch merge review created/).count(), 0, "accepted review receipt must clear when repository scope changes");
  await repository.selectOption("main");
  await page.getByText(/Current repository target: .* · project\/main\./).waitFor();
  const mergeRow = page.locator("tr").filter({ hasText: "/merge/" });
  await mergeRow.getByRole("button", { name: "Open review", exact: true }).click();
  try { await page.getByRole("button", { name: "Approve exact candidate", exact: true }).waitFor(); }
  catch (error) { process.stderr.write((await page.locator("body").innerText()) + "\nBrowser errors: " + errors.join("; ") + "\n"); throw error; }
  assert.equal(await page.getByRole("button", { name: "Promote protected ref", exact: true }).count(), 0);
  page.once("dialog", (dialog) => dialog.accept()); await page.getByRole("button", { name: "Approve exact candidate", exact: true }).click();
  await page.getByRole("button", { name: "Promote protected ref", exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept()); await page.getByRole("button", { name: "Promote protected ref", exact: true }).click();
  await page.getByText("Protected ref promotion accepted.", { exact: true }).waitFor();
  assert.equal((await git("/usr/bin/git", ["--git-dir", join(f.root, "state/project/main.git"), "rev-parse", "refs/heads/main"])).stdout.trim(), candidate);
  const publish = page.getByRole("button", { name: "Publish protected head", exact: true });
  page.once("dialog", (dialog) => dialog.accept()); await publish.click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Publish protected head" && !button.disabled));
  assert.equal((await git("/usr/bin/git", ["--git-dir", upstream, "rev-parse", "refs/heads/development"])).stdout.trim(), candidate, await page.locator("body").innerText());
  await repository.selectOption("secondary");
  await page.getByText(/Current repository target: .* · project\/secondary\./).waitFor();
  assert.equal(await page.getByText("Protected ref promotion accepted.", { exact: true }).count(), 0, "main promotion receipt must not leak into secondary scope");
  const secondaryPublish = page.getByRole("button", { name: "Publish protected head", exact: true });
  page.once("dialog", (dialog) => dialog.accept()); await secondaryPublish.click();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Publish protected head" && !button.disabled));
  assert.equal((await git("/usr/bin/git", ["--git-dir", secondaryUpstream, "rev-parse", "refs/heads/development"])).stdout.trim(), f.initial,
    "publishing from secondary scope must publish only the secondary protected head");
  assert.equal((await git("/usr/bin/git", ["--git-dir", upstream, "rev-parse", "refs/heads/development"])).stdout.trim(), candidate,
    "publishing the secondary repository must not alter the main repository upstream");
  assert.deepEqual(errors, []);
  process.stdout.write("Native Git branch merge, review, promotion and protected-head publish browser workflow passed.\n");
} finally { await browser?.close(); await web?.close(); await f.service.close(); await rm(f.root, { recursive: true, force: true }); await rm(upstreamRoot, { recursive: true, force: true }); }
