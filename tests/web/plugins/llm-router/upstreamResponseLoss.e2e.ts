import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { llmWebFixture } from "./fixture.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM is required");

const fixture = await llmWebFixture();
const originalConnection: unknown = JSON.parse(await readFile(fixture.connectionFile, "utf8"));
if (!originalConnection || typeof originalConnection !== "object" || !("endpoint" in originalConnection) || typeof originalConnection.endpoint !== "string") throw new Error("invalid fixture connection");
const upstreamOrigin = originalConnection.endpoint;
let lostResponses = 0;
const proxy = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const upstream = await fetch(new URL(request.url ?? "/", upstreamOrigin), {
      method: "POST",
      headers: {
        ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
        "content-type": request.headers["content-type"] ?? "application/json",
      },
      body: Buffer.concat(chunks),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (request.url === "/v1/operator/operations/project.state" && lostResponses === 0) {
      lostResponses++;
      response.destroy();
      return;
    }
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(body);
  })().catch(() => response.destroy());
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyAddress = proxy.address();
if (!proxyAddress || typeof proxyAddress === "string") throw new Error("missing response-loss proxy address");
await writeFile(fixture.connectionFile, JSON.stringify({ ...originalConnection, endpoint: `http://127.0.0.1:${proxyAddress.port}` }), { mode: 0o600 });
await fixture.restartWeb();
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const page = await browser.newPage();
  let writes = 0;
  page.on("request", (request) => { if (request.url().endsWith("/operations/project.state")) writes++; });
  await page.goto(fixture.origin);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "LLM router", exact: true }).click();
  await page.getByRole("link", { name: "Projects & policy", exact: true }).click();

  const pause = page.getByRole("button", { name: "Pause example", exact: true });
  await pause.click();
  await page.getByRole("alert").filter({ hasText: "outcome is unknown" }).waitFor();
  assert.equal(fixture.router.ledger.project("example").paused, true);
  assert.equal(await pause.isDisabled(), true);
  assert.equal(writes, 1);
  assert.equal(lostResponses, 1);

  await pause.click({ force: true });
  assert.equal(writes, 1);
  await page.getByRole("button", { name: "Refresh router", exact: true }).click();
  await page.getByRole("button", { name: "Resume example", exact: true }).waitFor();
  assert.equal(fixture.router.ledger.project("example").paused, true);
  assert.equal(writes, 1);
  process.stdout.write("A committed upstream LLM write with a lost response locks repeat submission and reconciles without replay.\n");
} finally {
  await browser.close();
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await fixture.close();
}
