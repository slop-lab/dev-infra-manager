import assert from 'node:assert/strict';
import type {Page} from 'playwright-core';

export async function assertReadOnlyExecutionAuthority(page: Page): Promise<void> {
  const guidance = page.locator('[data-execution-authority="retry"]');
  await guidance.waitFor();
  const copy = await guidance.innerText();
  assert.match(copy,/browser operator role/i);
  assert.match(copy,/operator-enabled service connection/i);
  assert.match(copy,/browser account has the operator role/i);
  assert.match(copy,/selected service connection is not operator-enabled/i);
  assert.equal(await page.getByRole('button',{name:'Retry execution',exact:true}).count(),0);
}

export async function assertBrowserRoleExecutionAuthority(page: Page): Promise<void> {
  const guidance = page.locator('[data-execution-authority="retry"]');
  await guidance.waitFor();
  const copy = await guidance.innerText();
  assert.match(copy,/browser operator role/i);
  assert.match(copy,/operator-enabled service connection/i);
  assert.match(copy,/selected service connection is operator-enabled/i);
  assert.match(copy,/browser account does not have the operator role/i);
  assert.equal(await page.getByRole('button',{name:'Retry execution',exact:true}).count(),0);
}

export async function assertWorkerOnlyExecutionAccess(page: Page): Promise<void> {
  await page.getByLabel('Controller',{exact:true}).selectOption('operator-only');
  await page.getByRole('heading',{name:'Job query access required',exact:true}).waitFor();
  await page.getByRole('link',{name:'Workers',exact:true}).click();
  await page.locator('.execution-worker-table').waitFor();
  await page.getByText('Job details require read access.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'View worker job',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Retry execution',exact:true}).count(),0);
}
