import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { JourneyContext } from "./context.ts";
import { endpointFamily, safeErrorCategory, safeLabel, type JourneyStep } from "./trace.ts";

const defaultArtifacts = fileURLToPath(new URL("../../../../.local/web-journeys/", import.meta.url));

/** Raw Playwright traces include passwords, fill arguments and network bodies.
 * This structured trace intentionally records only action timings and allowlisted
 * network metadata. It never captures console output, cookies or response bodies. */
export async function runBrowserJourney(name: string, journey: (context: JourneyContext) => Promise<void>): Promise<void> {
  safeLabel(name);
  const executablePath = process.env.DIM_CHROMIUM;
  if (!executablePath || !path.isAbsolute(executablePath)) throw new Error("DIM_CHROMIUM must select an absolute reviewed Chromium executable");
  await access(executablePath, constants.X_OK);
  const base = path.resolve(process.env.DIM_WEB_JOURNEY_ARTIFACTS ?? defaultArtifacts);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const artifactDirectory = await mkdtemp(path.join(base, `${name}-`));
  const steps: JourneyStep[] = [], cleanup: (() => Promise<void>)[] = [];
  const diagnostics: Record<string, number | boolean | null> = {};
  const network: { milliseconds: number; method: string; endpoint: string; status: number }[] = [];
  const started = performance.now();
  let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined;
  let failed = false, failureStep = "browser startup", failureCategory = "Error", pageErrors = 0, cleanupErrors = 0;
  let browserVersion = "unavailable";
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    browserVersion = browser.version();
    const expectedVersion = process.env.DIM_CHROMIUM_VERSION;
    if (expectedVersion && browserVersion !== expectedVersion) throw new Error("Chromium version differs from the selected journey version");
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    page = await context.newPage();
    page.on("pageerror", () => { pageErrors++; });
    page.on("response", (response) => {
      // Bound diagnostics even if a broken page continually retries.
      if (network.length < 2000) network.push({ milliseconds: Math.round(performance.now() - started), method: response.request().method(), endpoint: endpointFamily(response.url()), status: response.status() });
    });
    await journey({
      page, artifactDirectory,
      async step<T>(label: string, action: () => Promise<T>): Promise<T> {
        safeLabel(label); failureStep = label;
        const start = performance.now();
        try {
          const result = await action();
          steps.push({ name: label, milliseconds: Math.round(performance.now() - start), result: "passed" });
          return result;
        } catch (error) {
          steps.push({ name: label, milliseconds: Math.round(performance.now() - start), result: "failed" });
          throw error;
        }
      },
      cleanup(action) { cleanup.push(action); },
      diagnostic(label, value) {
        safeLabel(label);
        if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Journey diagnostics require finite numbers");
        diagnostics[label] = value;
      }
    });
    if (pageErrors > 0) { failureStep = "browser page errors"; failed = true; }
  } catch (error) { failed = true; failureCategory = safeErrorCategory(error); }
  finally {
    // Capture before fixture cleanup tears down the page's services.
    if (failed && page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifactDirectory, "failure.png"), fullPage: true,
        mask: [page.locator("input, textarea, [contenteditable], [data-secret], [data-sensitive], [data-copy-value], pre, code")],
        animations: "disabled" }).catch(() => { diagnostics.screenshotFailed = true; });
    }
    for (const dispose of cleanup.reverse()) {
      try { await dispose(); } catch { cleanupErrors++; if (!failed) { failureStep = "resource cleanup"; failureCategory = "CleanupError"; } failed = true; }
    }
    try { await context?.close(); } catch { cleanupErrors++; failed = true; }
    try { await browser?.close(); } catch { cleanupErrors++; failed = true; }
    await writeFile(path.join(artifactDirectory, "timings.json"), JSON.stringify({ journey: name, browserVersion, milliseconds: Math.round(performance.now() - started), steps }, null, 2), { mode: 0o600 });
    if (failed) {
      await writeFile(path.join(artifactDirectory, "trace.json"), JSON.stringify({ steps, network }, null, 2), { mode: 0o600 });
      await writeFile(path.join(artifactDirectory, "diagnostics.json"), JSON.stringify({ failureStep, failureCategory, pageErrors, cleanupErrors, ...diagnostics }, null, 2), { mode: 0o600 });
    }
  }
  if (failed) throw new Error(`Web journey ${name} failed at ${failureStep}; sanitized evidence: ${artifactDirectory}`);
}
