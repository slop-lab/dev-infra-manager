import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { llmWebFixture } from './fixture.js';
const executablePath = process.env.DIM_CHROMIUM; if (!executablePath) throw new Error('DIM_CHROMIUM is required');
const fixture = await llmWebFixture(), browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const accounts = [{ id: 'account-one', reference: 'Dedicated test account', provider: 'backend', status: 'configured' }];
  const management = ['accounts', 'account.create', 'account.login.start', 'account.login.status', 'route.upsert'];
  const writes: Array<{ name: string; input: Record<string, unknown> }> = [];
  let failAccounts = false;
  await page.route('**/v1/extensions', async (route) => {
    const response = await route.fetch(), features = await response.json() as Array<{ id: string; operations: Array<{ name: string; description: string; access: string }> }>;
    const feature = features.find((value) => value.id === 'llm-router')!;
    for (const name of management) if (!feature.operations.some((value) => value.name === name)) feature.operations.push({ name, description: name, access: name === 'accounts' ? 'read' : 'operator' });
    await route.fulfill({ response, json: features });
  });
  await page.route('**/v1/extensions/llm-router/operations/*', async (route) => {
    const name = route.request().url().split('/').at(-1)!; if (!management.includes(name)) { await route.continue(); return; }
    const input = route.request().postDataJSON() as Record<string, unknown>;
    if (name === 'accounts') { if (failAccounts) { failAccounts = false; await route.fulfill({ status: 503, json: { error: 'read unavailable' } }); } else await route.fulfill({ json: accounts }); return; }
    writes.push({ name, input });
    if (name === 'account.create') { const account = { id: String(input.accountId), reference: String(input.reference), provider: String(input.provider), status: input.provider === 'codex' ? 'authorization_required' : 'configured' }; accounts.push(account); await route.fulfill({ json: account }); }
    if (name === 'account.login.start') await route.fulfill({ json: { accountId: input.accountId, sessionId: `session-${String(input.accountId)}`, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE', status: 'pending', expiresAt: Date.now() + 600_000 } });
    if (name === 'account.login.status') { const account = accounts.find((value) => value.id === input.accountId)!; account.status = 'connected'; await route.fulfill({ json: { accountId: input.accountId, sessionId: input.sessionId, status: 'connected' } }); }
    if (name === 'route.upsert') await route.fulfill({ json: { id: input.routeId, accountId: input.accountId, models: input.models } });
  });
  await page.goto(fixture.origin); await page.getByLabel('Username', { exact: true }).fill(fixture.username); await page.getByLabel('Password', { exact: true }).fill(fixture.password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'LLM router', exact: true }).click(); await page.getByRole('heading', { name: 'Provider accounts', exact: true }).waitFor();
  await page.getByText('Connect provider account', { exact: true }).click();
  await page.getByLabel('Account ID', { exact: true }).fill('codex-one'); await page.getByLabel('Account label', { exact: true }).fill('First Codex'); await page.getByRole('button', { name: 'Add provider account', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Codex codex-one', exact: true }).click(); await page.getByText('Authorization code: TEST-CODE', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open Codex authorization' }).getAttribute('href'), 'https://auth.openai.com/codex/device');
  await page.getByRole('button', { name: 'Check Codex connection codex-one', exact: true }).click(); await page.getByText('Account connected.', { exact: true }).waitFor();
  const secret = 'sk-browser-private-secret';
  await page.getByLabel('Provider type', { exact: true }).selectOption('openai');
  assert.equal(await page.getByLabel('API base URL', { exact: true }).inputValue(), 'https://api.openai.com/v1');
  await page.getByLabel('API key', { exact: true }).fill(secret);
  await page.getByLabel('Provider type', { exact: true }).selectOption('anthropic');
  assert.equal(await page.getByLabel('API base URL', { exact: true }).inputValue(), 'https://api.anthropic.com');
  assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
  for (const [id, provider, label] of [['openai-two', 'openai', 'OpenAI key'], ['anthropic-three', 'anthropic', 'Anthropic key']]) {
    await page.getByLabel('Provider type', { exact: true }).selectOption(provider!); await page.getByLabel('Account ID', { exact: true }).fill(id!); await page.getByLabel('Account label', { exact: true }).fill(label!); await page.getByLabel('API base URL', { exact: true }).fill(provider === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com'); await page.getByLabel('API key', { exact: true }).fill(secret);
    failAccounts = true; await page.getByRole('button', { name: 'Add provider account', exact: true }).click(); await page.getByText(`${id} added. The account list could not refresh; use Refresh router. The account was accepted.`, { exact: true }).waitFor();
    assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), ''); assert.equal(await page.getByRole('button', { name: 'Add provider account', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('body').innerText().then((value) => value.includes(secret)), false);
    await page.getByRole('button', { name: 'Refresh router', exact: true }).click(); await page.getByRole('heading', { name: `${id} · ${label}`, exact: true }).waitFor();
  }
  assert.equal(writes.filter((value) => value.name === 'account.create').length, 3);
  await page.getByLabel('Route ID', { exact: true }).fill('secondary'); await page.getByLabel('Route account', { exact: true }).selectOption('anthropic-three'); await page.getByLabel('Model ID', { exact: true }).fill('claude-test'); await page.getByLabel('Model name', { exact: true }).fill('Claude test'); await page.getByLabel('Model API', { exact: true }).selectOption('chat'); await page.getByRole('button', { name: 'Save route', exact: true }).click(); await page.getByText('Route secondary saved.', { exact: true }).waitFor();
  assert.equal(writes.find((value) => value.name === 'route.upsert')?.input.accountId, 'anthropic-three');
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []); assert.equal(fixture.inferenceRequests(), 0);
  console.log('LLM account UI: multiple providers, Codex device authorization, secret wiping, accepted write receipts, account route selection and mobile PASS');
} finally { await browser.close(); await fixture.close(); }
