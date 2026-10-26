import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";

export async function captureLinkState(page: Page, state: "authentication" | "project" | "unavailable"): Promise<void> {
  const directory = process.env.DIM_WEB_EVIDENCE;
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: join(directory, `${state}-${width}.png`), animations: "disabled", mask: [page.locator("input, textarea")] });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
