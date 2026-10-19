// @ts-check
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import pin from "../../../../tools/opencode-web/upstream.json" with { type: "json" };

const artifact = process.argv[2];
if (!artifact) throw new Error("usage: node opencodePages.e2e.mjs BUILT_PAGES_DIRECTORY");
const root = path.resolve(artifact);
const server = createServer((request, response) => {
  void (async () => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!pathname.startsWith(pin.pagesBase)) { response.writeHead(404).end(); return; }
    const file = path.resolve(root, decodeURIComponent(pathname.slice(pin.pagesBase.length)) || "index.html");
    if (!file.startsWith(root + path.sep)) { response.writeHead(404).end(); return; }
    const contentTypes = new Map([[".js", "text/javascript"], [".css", "text/css"], [".json", "application/json"], [".html", "text/html"], [".wasm", "application/wasm"], [".svg", "image/svg+xml"], [".woff2", "font/woff2"]]);
    response.setHeader("content-type", contentTypes.get(path.extname(file)) ?? "application/octet-stream");
    response.end(await readFile(file));
  })().catch(() => response.writeHead(404).end());
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
const address = server.address(); if (!address || typeof address === "string") throw new Error("missing Pages listener");
const browser = await chromium.launch({ executablePath: process.env.DIM_CHROMIUM ?? "/usr/bin/google-chrome", headless: true });
try {
  const page = await browser.newPage();
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const implicitRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/\/(?:global\/health|event|session)(?:[/?]|$)/.test(new URL(request.url()).pathname)) implicitRequests.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${address.port}${pin.pagesBase}`);
  const add = page.getByRole("button", { name: "Add server", exact: true });
  await add.waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(500);
  assert.deepEqual(implicitRequests, [], "static UI must not treat Pages as an OpenCode backend");
  await add.click();
  await page.getByRole("dialog").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
  console.log("Pinned OpenCode Pages UI: disconnected startup, Add server dialog and no implicit backend requests passed");
} finally { await browser.close(); await new Promise((resolve) => server.close(() => resolve(undefined))); }
