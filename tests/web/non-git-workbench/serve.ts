import { writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { availablePort } from "../webHarness.js";
import { createNonGitWorkbench } from "./harness.js";

const chromiumPath = process.env.DIM_CHROMIUM ?? "/usr/bin/chromium";
const metadataFlag = process.argv.indexOf("--metadata");
const metadataPath = metadataFlag < 0 ? undefined : process.argv[metadataFlag + 1];
const fixture = await createNonGitWorkbench();
const cdpPort = await availablePort();
let browser: Browser | undefined;
let browserLaunchError: string | null = null;
try {
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(fixture.origin);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  browserLaunchError = error.message.split("\n", 1)[0] ?? "Chromium launch failed";
}
const metadata = {
  origin: fixture.origin,
  health: `${fixture.origin}/healthz`,
  username: fixture.username,
  password: fixture.password,
  readonlyUsername: fixture.readonlyUsername,
  cdpUrl: browser === undefined ? null : `http://127.0.0.1:${cdpPort}`,
  browserLaunchError,
  pid: process.pid,
  cleanup: `kill ${process.pid}`,
  capabilities: fixture.capabilities
};
if (metadataPath !== undefined) await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await browser?.close();
  await fixture.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close().then(() => process.exit(0)); });
await new Promise<void>(() => {});
