import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { llmWebFixture } from './fixture.js';
const executablePath = process.env.DIM_CHROMIUM; if (!executablePath) throw new Error('DIM_CHROMIUM is required');
const fixture = await llmWebFixture(), browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const accounts = [{ id: 'account-one', reference: 'Dedicated test account', provider: 'backend', status: 'configured' }];
  const management = ['accounts', 'account.create', 'account.rename', 'account.login.start', 'account.login.status', 'route.upsert'];
  const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
  let failAccounts = false;
  const savedRoutes: Array<{ id: unknown; accountId: unknown; models: unknown }> = [];
  await page.route('**/v1/extensions', async (route) => {
    const response = await route.fetch(), features = await response.json() as Array<{ id: string; operations: Array<{ name: string; description: string; access: string }> }>;
    const feature = features.find((value) => value.id === 'llm-router')!;
    for (const name of management) if (!feature.operations.some((value) => value.name === name)) feature.operations.push({ name, description: name, access: name === 'accounts' ? 'read' : 'operator' });
    await route.fulfill({ response, json: features });
  });
  await page.route('**/v1/extensions/llm-router/operations/*', async (route) => {
    const name = route.request().url().split('/').at(-1)!;
    if (name === 'overview') { const response = await route.fetch(), overview = await response.json() as { routes: unknown[] }; await route.fulfill({ response, json: { ...overview, routes: [...overview.routes, ...savedRoutes] } }); return; }
    if (!management.includes(name)) { await route.continue(); return; }
    const input = route.request().postDataJSON() as Record<string, unknown>;
    if (name === 'accounts') { if (failAccounts) { failAccounts = false; await route.fulfill({ status: 503, json: { error: 'read unavailable' } }); } else await route.fulfill({ json: accounts }); return; }
    writes.push({ name, input });
    if (name === 'account.create') { const account = { id: String(input.accountId ?? `${String(input.provider)}-${accounts.length}`), reference: String(input.reference ?? (input.provider === 'codex' ? 'Codex account' : 'API account')), provider: String(input.provider), status: input.provider === 'codex' ? 'authorization_required' : 'configured' }; accounts.push(account); await route.fulfill({ json: account }); }
    if (name === 'account.rename') { const account = accounts.find((value) => value.id === input.accountId)!; account.reference = String(input.reference); await route.fulfill({ json: account }); }
    if (name === 'account.login.start') await route.fulfill({ json: { accountId: input.accountId, sessionId: `session-${String(input.accountId)}`, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE', status: 'pending', expiresAt: Date.now() + 600_000 } });
    if (name === 'account.login.status') { const account = accounts.find((value) => value.id === input.accountId)!; account.status = 'connected'; if (account.reference === 'Codex account') account.reference = `${account.id}@example.test`; await route.fulfill({ json: { accountId: input.accountId, sessionId: input.sessionId, status: 'connected' } }); }
    if (name === 'route.upsert') { const saved = { id: input.routeId, accountId: input.accountId, models: input.models }; savedRoutes.push(saved); await route.fulfill({ json: saved }); }
  });
  await page.goto(fixture.origin); await page.getByLabel('Username', { exact: true }).fill(fixture.username); await page.getByLabel('Password', { exact: true }).fill(fixture.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'LLM router', exact: true }).click(); await page.getByRole('heading', { name: 'Provider accounts', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Account ID', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Connect Codex account', exact: true }).click();
  await page.getByText('Authorization code: TEST-CODE', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open Codex authorization' }).getAttribute('href'), 'https://auth.openai.com/codex/device');
  await page.getByText('Account connected.', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'codex-1@example.test', exact: true }).waitFor();
  assert.deepEqual(writes.find((value) => value.name === 'account.create')?.input, { provider: 'codex' });
  const rename = page.getByRole('form', { name: 'Rename codex-1@example.test', exact: true });
  await page.locator('article').filter({ has: page.getByRole('heading', { name: 'codex-1@example.test', exact: true }) }).getByText('Rename account', { exact: true }).click();
  await rename.getByLabel('Display name', { exact: true }).fill('Work account'); await rename.getByRole('button', { name: 'Save name', exact: true }).click();
  await page.getByRole('heading', { name: 'Work account', exact: true }).waitFor();
  assert.equal(writes.find((value) => value.name === 'account.rename')?.input.accountId, 'codex-1');
  await page.getByRole('button', { name: 'Connect Codex account', exact: true }).click();
  await page.getByRole('heading', { name: 'codex-2@example.test', exact: true }).waitFor();
  await page.getByText('Connect API provider', { exact: true }).click();
  const secret = 'sk-browser-private-secret';
  await page.getByLabel('Provider type', { exact: true }).selectOption('openai');
  assert.equal(await page.getByLabel('API base URL', { exact: true }).inputValue(), 'https://api.openai.com/v1');
  await page.getByLabel('API key', { exact: true }).fill(secret);
  await page.getByLabel('Provider type', { exact: true }).selectOption('anthropic');
  assert.equal(await page.getByLabel('API base URL', { exact: true }).inputValue(), 'https://api.anthropic.com');
  assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
  for (const [id, provider, label] of [['openai-3', 'openai', 'OpenAI key'], ['anthropic-4', 'anthropic', 'Anthropic key']]) {
    await page.getByLabel('Provider type', { exact: true }).selectOption(provider!); await page.getByLabel('Account label (optional)', { exact: true }).fill(label!); await page.getByLabel('API base URL', { exact: true }).fill(provider === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com'); await page.getByLabel('API key', { exact: true }).fill(secret);
    failAccounts = true; await page.getByRole('button', { name: 'Add provider account', exact: true }).click(); await page.getByText(`${id} added. The account list could not refresh; use Refresh router. The account was accepted.`, { exact: true }).waitFor();
    assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), ''); assert.equal(await page.getByRole('button', { name: 'Add provider account', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('body').innerText().then((value) => value.includes(secret)), false);
    await page.getByRole('button', { name: 'Refresh router', exact: true }).click(); await page.getByRole('heading', { name: label!, exact: true }).waitFor();
  }
  assert.equal(writes.filter((value) => value.name === 'account.create').length, 4);
  assert.equal(await page.getByLabel('Allowed models', { exact: true }).inputValue(), 'all');
  assert.equal(await page.getByLabel('Model ID', { exact: true }).isVisible(), false);
  await page.getByLabel('Route ID', { exact: true }).fill('all-codex'); await page.getByLabel('Route account', { exact: true }).selectOption('codex-1'); await page.getByRole('button', { name: 'Save route', exact: true }).click(); await page.getByText('Route all-codex saved.', { exact: true }).waitFor();
  assert.deepEqual(writes.find((value) => value.name === 'route.upsert')?.input, { routeId: 'all-codex', accountId: 'codex-1', models: 'all' });
  await page.getByRole('cell', { name: 'All models from this account', exact: true }).waitFor();
  await page.getByLabel('Load route', { exact: true }).selectOption('all-codex'); assert.equal(await page.getByLabel('Allowed models', { exact: true }).inputValue(), 'all');
  await page.getByLabel('Load route', { exact: true }).selectOption('');
  await page.getByLabel('Allowed models', { exact: true }).selectOption('selected');
  await page.getByLabel('Route ID', { exact: true }).fill('secondary'); await page.getByLabel('Route account', { exact: true }).selectOption('anthropic-4'); await page.getByLabel('Model ID', { exact: true }).fill('claude-test'); await page.getByLabel('Model name', { exact: true }).fill('Claude test'); await page.getByLabel('Model API', { exact: true }).selectOption('chat'); await page.getByRole('button', { name: 'Save route', exact: true }).click(); await page.getByText('Route secondary saved.', { exact: true }).waitFor();
  assert.equal(writes.filter((value) => value.name === 'route.upsert').at(-1)?.input.accountId, 'anthropic-4');
  await page.getByLabel('Load route', { exact: true }).selectOption('secondary'); assert.equal(await page.getByLabel('Allowed models', { exact: true }).inputValue(), 'selected'); assert.equal(await page.getByLabel('Model ID', { exact: true }).inputValue(), 'claude-test');
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []); assert.equal(fixture.inferenceRequests(), 0);
  console.log('LLM account UI: multiple providers, Codex device authorization, secret wiping, accepted write receipts, account route selection, all/selected model policy round trips and mobile PASS');
} finally { await browser.close(); await fixture.close(); }
