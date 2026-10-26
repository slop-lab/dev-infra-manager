import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createLlmRouterClient } from '../../../../packages/service-clients/llm-router/src/index.js';
import { llmWebFixture } from './fixture.js';
const executablePath = process.env.DIM_CHROMIUM; if (!executablePath) throw new Error('DIM_CHROMIUM is required');
const first = await llmWebFixture(), second = await llmWebFixture();
first.router.ledger.issue({ id: 'first-workspace', name: 'First workspace' }, 'default', 'example', 'first-principal');
second.router.ledger.issue({ id: 'second-workspace', name: 'Second workspace' }, 'default', 'example', 'second-principal');
const clients = { first: createLlmRouterClient(first.connectionFile), second: createLlmRouterClient(second.connectionFile) };
const capabilities = await clients.first.capabilities();
const browser = await chromium.launch({ executablePath, headless: true });
let releaseOverview: () => void = () => {}, markOverview: () => void = () => {};
const overviewGate = new Promise<void>((resolve) => { releaseOverview = resolve; }), overviewStarted = new Promise<void>((resolve) => { markOverview = resolve; });
let holdOverview = false, firstReady = true;
const reads: Array<{controllerId: unknown; name: string}> = [];
const writes: Array<{ controllerId: string; name: string }> = [], errors: string[] = [];
try {
  const page = await browser.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/v1/extensions', async (route) => {
    const response = await route.fetch(), features = await response.json() as Array<{ id: string; operations: Array<{ name: string; description: string; access: string }> }>;
    features.find(({ id }) => id === 'llm-router')!.operations.unshift({ name: 'controllers.list', description: 'Router controllers', access: 'read' });
    await route.fulfill({ response, json: features });
  });
  await page.route('**/v1/extensions/llm-router/operations/*', async (route) => {
    const name = route.request().url().split('/').at(-1)!;
    if (name === 'controllers.list') { await route.fulfill({ json: { controllers: ['first', 'second', 'offline'].map((id) => ({ id, controllerKey: id, title: id, status: id === 'offline' || id === 'first' && !firstReady ? 'unavailable' : 'ready', operations: id === 'offline' || id === 'first' && !firstReady ? [] : capabilities })) } }); return; }
    const { controllerId, ...input } = route.request().postDataJSON() as Record<string, unknown>;
    if (controllerId !== 'first' && controllerId !== 'second') throw new Error('Operation did not select an exact router controller');
    reads.push({controllerId,name});
    if (name === 'overview' && controllerId === 'first' && holdOverview) { holdOverview = false; markOverview(); await overviewGate; }
    if (capabilities.find((operation) => operation.name === name)?.access !== 'read') writes.push({ controllerId, name });
    const result = await clients[controllerId].invoke(name, input);
    await route.fulfill({ json: name === 'overview' ? { ...result as object, backend: { ...(result as {backend:object}).backend, name: controllerId + ' backend' } } : result });
  });
  await page.goto(first.origin); await page.getByLabel('Username', { exact: true }).fill(first.username); await page.getByLabel('Password', { exact: true }).fill(first.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'LLM router', exact: true }).click();
  await page.getByText(/^first backend /).waitFor();
  // Given the router root's default task and a local project draft.
  await page.getByRole('link', { name: 'Projects & policy', exact: true }).click();
  await page.getByRole('heading', { name: 'Routing projects', exact: true }).waitFor();
  await page.getByText('New routing project', { exact: true }).click();
  await page.getByLabel('Project ID', { exact: true }).fill('retained-history-draft');
  // When browser history returns to the bare feature root.
  await page.goBack();
  await page.waitForURL(/#\/features\/llm-router$/);
  // Then the default task is restored without discarding its draft.
  await page.getByRole('heading', { name: 'Accounts & routes', exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await page.getByRole('link', { name: 'Accounts & routes', exact: true }).getAttribute('aria-current'), 'page');
  await page.goForward();
  await page.getByLabel('Project ID', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Project ID', { exact: true }).inputValue(), 'retained-history-draft');
  await page.getByRole('link', { name: 'example', exact: true }).click();
  await page.getByLabel('Allowed routes (comma separated)', { exact: true }).fill('unsaved-first-route');
  await page.getByRole('link', { name: 'Traffic & access', exact: true }).click();
  await page.getByRole('button', { name: 'Open routing project example', exact: true }).click();
  await page.waitForURL(/#\/features\/llm-router\/projects\/first\/example$/);
  await page.getByRole('heading', { name: 'Project example', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Router controller', { exact: true }).inputValue(), 'first');
  assert.equal(await page.getByLabel('Allowed routes (comma separated)', { exact: true }).inputValue(), 'unsaved-first-route');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.evaluate(() => { window.location.hash = '#/features/llm-router/accounts/second'; });
  await page.waitForURL(/#\/features\/llm-router\/projects\/first\/example$/);
  assert.equal(await page.getByLabel('Router controller', { exact: true }).inputValue(), 'first');
  assert.equal(await page.getByLabel('Allowed routes (comma separated)', { exact: true }).inputValue(), 'unsaved-first-route');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByLabel('Router controller', { exact: true }).selectOption('second');
  assert.equal(await page.getByLabel('Router controller', { exact: true }).inputValue(), 'first');
  assert.equal(await page.getByLabel('Allowed routes (comma separated)', { exact: true }).inputValue(), 'unsaved-first-route');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByLabel('Router controller', { exact: true }).selectOption('second');
  await page.getByText(/^second backend /).waitFor();
  assert.equal(await page.getByLabel('Allowed routes (comma separated)', { exact: true }).count(), 0);
  await page.getByRole('link', { name: 'Projects & policy', exact: true }).click();
  await page.getByRole('link', { name: 'example', exact: true }).click();
  await page.getByLabel('Allowed routes (comma separated)', { exact: true }).fill('default');
  // Saving is an intentional mutation only against this disposable second router.
  await page.getByRole('button', { name: 'Save routing policy', exact: true }).click();
  await page.getByText('Policy saved for example.', { exact: true }).waitFor();
  assert.deepEqual(writes, [{ controllerId: 'second', name: 'project.policy.update' }]);
  holdOverview = true;
  await page.getByLabel('Router controller', { exact: true }).selectOption('first'); await overviewStarted;
  await page.getByLabel('Router controller', { exact: true }).selectOption('second'); await page.getByText(/^second backend /).waitFor();
  releaseOverview(); await page.waitForTimeout(100);
  assert.equal(await page.getByText(/^first backend /).count(), 0);
  await page.getByLabel('Router controller', { exact: true }).selectOption('offline');
  await page.getByText(/^LLM router is unavailable on this controller/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save routing policy', exact: true }).count(), 0);
  firstReady = false;
  await page.goto('about:blank');
  const readCount = reads.length;
  await page.goto(`${first.origin}/#/features/llm-router/projects/first/example`);
  await page.getByText(/^LLM router is unavailable on this controller/).waitFor();
  assert.equal(new URL(page.url()).hash,'#/features/llm-router/projects/first/example');
  assert.equal(reads.length,readCount);
  await page.getByLabel('Router controller', {exact:true}).selectOption('second');
  await page.getByText(/^second backend /).waitFor();
  assert.equal(await page.getByRole('link',{name:'Projects & policy',exact:true}).getAttribute('href'),'#/features/llm-router/projects/second');
  const readsBeforeMissing = reads.length;
  await page.goto(`${first.origin}/#/features/llm-router/projects/missing/example`);
  await page.getByText(/^The requested router controller is unavailable/).waitFor();
  assert.equal(reads.length,readsBeforeMissing);
  assert.equal(new URL(page.url()).hash,'#/features/llm-router/projects/missing/example');
  assert.equal(first.inferenceRequests() + second.inferenceRequests(), 0); assert.deepEqual(errors, []);
  console.log('Router controller selection, draft confirmation, exact write binding, late-read fencing and unavailable isolation PASS (two disposable routers, no inference)');
} finally { releaseOverview(); await browser.close(); await second.close(); await first.close(); }
