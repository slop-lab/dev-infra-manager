import {mkdir} from 'node:fs/promises';
import type {Locator, Page} from 'playwright-core';
export function createBrowserEvidence(page: Page) {
  return async (name: string, target?: Locator): Promise<void> => {
    const directory = process.env.DIM_WEB_EVIDENCE;
    if (!directory) return;
    await mkdir(directory, {recursive:true});
    const path = `${directory}/${name}.png`;
    if (target) await target.screenshot({path});
    else await page.screenshot({path});
  };
}
