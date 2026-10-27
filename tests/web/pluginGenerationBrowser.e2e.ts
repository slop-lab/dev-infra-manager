import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createNonGitWorkbench } from "./non-git-workbench/harness.js";
import { WORKSPACE_IDS } from "./non-git-workbench/state.js";

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error("DIM_CHROMIUM is required");
const fixture = await createNonGitWorkbench(), browser = await chromium.launch({ executablePath, headless: true }), page = await browser.newPage();
let catalogGeneration = "", invocationGeneration = "";
try {
  page.on("response", async (response) => {
    if (!response.url().endsWith("/v1/extensions") || response.request().method() !== "GET") return;
    const catalog: unknown = await response.json();
    if (!Array.isArray(catalog)) return;
    const feature = catalog.find((entry) => entry !== null && typeof entry === "object" && "id" in entry && entry.id === "external-urls");
    if (feature !== undefined && "generation" in feature && typeof feature.generation === "number") catalogGeneration = String(feature.generation);
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/operations/routes.create")) invocationGeneration = request.headers()["x-dim-plugin-generation"] ?? "";
  });
  await page.goto(`${fixture.origin}/#/workspaces/local/${WORKSPACE_IDS.running}/routes`);
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const row = page.locator(".workspace-row:visible");
  await row.getByRole("form", { name: "Create route for studio", exact: true }).waitFor();
  await row.getByLabel("Route name", { exact: true }).fill("generation-bound-route");
  await row.getByRole("button", { name: "Create route", exact: true }).click();
  await row.getByText("Awaiting operator approval.", { exact: false }).waitFor();
  assert.match(catalogGeneration, /^[1-9][0-9]*$/);
  assert.equal(invocationGeneration, catalogGeneration);
  process.stdout.write("Browser feature invocation carried its server catalog generation.\n");
} finally { await browser.close(); await fixture.close(); }
