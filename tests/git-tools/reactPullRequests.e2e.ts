import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM must select the reviewed Chromium executable");
const result = await build({ entryPoints: [fileURLToPath(new URL("./fixtures/controlledPanel.ts", import.meta.url))], bundle: true, format: "esm", platform: "browser", conditions: ["source"], write: false });
const script = result.outputFiles[0]?.contents; if (!script) throw new Error("Missing portable panel bundle");
const styles = await Promise.all([
  readFile(fileURLToPath(new URL("../../packages/git-tools/react-git-pull-requests/src/styles.css", import.meta.url))),
  readFile(fileURLToPath(new URL("../../packages/git-tools/react-diff/src/styles.css", import.meta.url)))
]);
const server = createServer((request, response) => {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'");
  if (request.url === "/panel.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); }
  else if (request.url === "/panel.css") { response.setHeader("Content-Type", "text/css"); response.end(Buffer.concat(styles)); }
  else if (request.url === "/") { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/panel.css"><main></main><script type="module" src="/panel.js"></script>'); }
  else { response.statusCode = 404; response.end(); }
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ executablePath, headless: true, timeout: 15_000 });
  if (process.env.DIM_CHROMIUM_VERSION) assert.equal(browser.version(), process.env.DIM_CHROMIUM_VERSION);
  const page = await browser.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole("heading", { name: "First request", exact: true }).waitFor();
  await page.getByText("Inspect commits", { exact: true }).click();
  await page.getByLabel("Base commit", { exact: true }).fill("a".repeat(40));
  await page.getByLabel("Head commit", { exact: true }).fill("b".repeat(40));
  await page.getByRole("button", { name: "Inspect diff", exact: true }).click();
  const inspection = page.locator("details").filter({ hasText: "Inspect commits" });
  await inspection.getByRole("region", { name: "Diff for file", exact: true }).waitFor();
  await page.getByLabel("Blame commit", { exact: true }).fill("b".repeat(40));
  await page.getByLabel("File path", { exact: true }).fill("file");
  await page.getByLabel("Line number", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Inspect blame", exact: true }).click();
  await page.getByText(/DIM Journey · b+ · direct inspection/).waitFor();
  if (process.env.DIM_WEB_EVIDENCE) await page.screenshot({ path: `${process.env.DIM_WEB_EVIDENCE}/portable-pr-direct-inspection.png`, fullPage: true });
  await page.getByLabel("Comment", { exact: true }).fill("Draft for first request");
  await page.getByRole("button", { name: "Select head line 1 of file", exact: true }).click();
  await page.getByText("Comment on file · head line 1", { exact: false }).waitFor();
  await page.evaluate(async () => { const modulePath = "/panel.js"; const module = await import(modulePath) as typeof import("./fixtures/controlledPanel.js"); module.selectSecond(); });
  await page.getByRole("heading", { name: "Second request", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Comment", { exact: true }).inputValue(), "");
  assert.equal(await page.getByText("Comment on file · head line 1", { exact: false }).count(), 0);
  await page.getByLabel("Comment", { exact: true }).fill("Accepted while callback remains pending");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await page.getByRole("article", { name: "Comment by reviewer" }).getByText("Accepted while callback remains pending", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Comment", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Select head line 1 of file", exact: true }).count(), 0);
  await page.evaluate(async () => { const modulePath = "/panel.js"; const module = await import(modulePath) as typeof import("./fixtures/controlledPanel.js"); module.releaseComment(); });
  await page.getByRole("button", { name: "Select head line 1 of file", exact: true }).click();
  await page.getByLabel("Comment", { exact: true }).fill("Anchored on second request");
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await page.getByRole("article", { name: "Comment by reviewer" }).getByText("Anchored on second request", { exact: true }).waitFor();
  const recorded = await page.evaluate(async () => { const modulePath = "/panel.js"; const module = await import(modulePath) as typeof import("./fixtures/controlledPanel.js"); return module.submitted; });
  assert.ok(recorded[0]);
  assert.equal(recorded[0].revisionId, "b:c"); assert.equal(recorded[0].anchor, undefined);
  assert.deepEqual(recorded[1], { revisionId: "b:c", body: "Anchored on second request", anchor: { path: "file", side: "head", line: 1 } });
  if (process.env.DIM_WEB_EVIDENCE) {
    await page.setViewportSize({ width: 375, height: 812 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
      .map((element) => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right })));
    assert.deepEqual(overflow, []);
    await page.screenshot({ path: `${process.env.DIM_WEB_EVIDENCE}/portable-pr-mobile.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log("Portable React PR panel: opaque identities, scoped drafts and pending comment selection passed");
} finally {
  try { await browser?.close(); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
