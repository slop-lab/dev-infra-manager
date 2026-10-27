import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createOperationsBrowserFixture } from './operationsBrowserFixture.js';

const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error('DIM_CHROMIUM is required');
const fixture = await createOperationsBrowserFixture(), browser = await chromium.launch({ executablePath, headless: true });
const workspace = await fixture.workspace();
const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
let running = false, exists = false, approval = 'pending', loseCreate = false;
const tools = ['controllers.list', 'tools.status', 'server.status', 'server.start', 'server.stop'];
const routes = ['routes.list', 'routes.create', 'routes.approve', 'routes.revoke'];
const snapshot = () => ({ ingresses: [{ name: 'public', description: 'Reviewed shared ingress', scheme: 'https', driver: 'relay' }], routes: exists ? [{ id: '37094660-a627-4a17-acd2-6418c0b79967', ingress: 'public', url: 'https://workspace.example.test', approval, port: 4096, containers: [], protocol: 'http' }] : [] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }), errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.route('**/v1/extensions', (route) => route.fulfill({ json: [
    { id: 'agent-tools', title: 'Workspace tools', description: 'Workspace application tools', surfaces: ['workspace'], status: 'ready', configured: true, browserEntry: '/fixture-tools.js', operations: tools.map((name) => ({ name, description: name, access: name.endsWith('status') || name.endsWith('list') ? 'read' : 'operator' })) },
    { id: 'external-urls', title: 'External routes', description: 'Workspace external access', surfaces: ['workspace'], status: 'ready', configured: true, browserEntry: '/fixture-routes.js', operations: routes.map((name) => ({ name, description: name, access: name.endsWith('list') ? 'read' : 'operator' })) }
  ] }));
  for (const [url, plugin] of [['fixture-tools.js', 'agent-tools'], ['fixture-routes.js', 'external-urls']]) {
    const body = await readFile(new URL(`../../packages/web/plugins/${plugin}/src/assets/panel.js`, import.meta.url), 'utf8');
    await page.route(`**/${url}`, (route) => route.fulfill({ contentType: 'text/javascript', body }));
  }
  await page.route('**/workspace-link.js', async (route) => route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../../packages/web/plugins/agent-tools/src/assets/workspace-link.js', import.meta.url), 'utf8') }));
  await page.route('**/v1/extensions/*/operations/*', async (route) => {
    const name = route.request().url().split('/').at(-1);
    if (!name) throw new Error('Missing fixture operation');
    const input: Record<string, unknown> = route.request().postDataJSON(); calls.push({ name, input });
    if (name === 'controllers.list') { await route.fulfill({ json: { controllers: [{ id: 'devbox', title: 'Development host', status: 'ready', workspaces: [workspace], tools: ['opencode'] }] } }); return; }
    if (name.startsWith('tools.')) { await route.fulfill({ json: { tools: [{ name: 'opencode', installed: true, version: '1.18.31' }] } }); return; }
    if (name.startsWith('server.')) {
      if (name === 'server.start') running = true;
      if (name === 'server.stop') running = false;
      await route.fulfill({ json: { state: running ? 'running' : 'stopped', port: 4096, url: 'http://127.0.0.1:4096', directory: '/workspace/main', username: 'opencode', externalUrls: approval === 'approved' ? snapshot().routes : [] } }); return;
    }
    if (name === 'routes.create') { exists = true; if (loseCreate) { loseCreate = false; await route.fulfill({ status: 503, json: {} }); return; } }
    if (name === 'routes.approve') approval = 'approved';
    if (name === 'routes.revoke') approval = 'revoked';
    await route.fulfill({ json: snapshot() });
  });
  await page.goto(fixture.origin);
  await page.getByLabel('Username', { exact: true }).fill(fixture.username);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const row = page.locator('.workspace-row').filter({ has: page.getByRole('heading', { name: 'development', exact: true }) });
  await page.getByRole('link', {name:'Open development on devbox',exact:true}).click();
  await row.getByRole('link', {name:'Tools',exact:true}).click();
  await row.getByRole('button', { name: 'Start OpenCode server', exact: true }).click();
  await row.getByText('Start OpenCode server completed.', { exact: true }).waitFor();
  await row.getByRole('button', { name: 'Configure external access', exact: true }).click();
  await row.getByText('Routes refreshed.', { exact: true }).waitFor();
  assert.equal(await row.getByRole('button', { name: 'Create route', exact: true }).isVisible(), true);
  const name = row.getByLabel('Route name', { exact: true }); await name.fill('browser-access');
  loseCreate = true;
  await row.getByRole('button', { name: 'Create route', exact: true }).click();
  await row.getByText('Route change outcome is unknown.', { exact: false }).waitFor();
  assert.equal(await row.getByRole('button', { name: 'Create route', exact: true }).isDisabled(), true);
  await row.getByRole('button', { name: 'Refresh routes', exact: true }).click();
  await row.getByText('Awaiting operator approval.', { exact: false }).waitFor();
  assert.equal(await name.inputValue(), 'browser-access');
  assert.equal(calls.filter(({ name }) => name === 'routes.create').length, 1);
  await row.getByRole('button', { name: 'Approve route', exact: true }).click();
  await row.getByRole('link', { name: 'https://workspace.example.test', exact: true }).waitFor();
  await row.getByRole('link', {name:'Tools',exact:true}).click();
  await row.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await row.getByText('Refresh status completed.', { exact: true }).waitFor();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await row.locator('.feature-form').evaluateAll((forms) => forms.every((form) => form.scrollWidth <= form.clientWidth + 1)), true, `workspace feature content fits at ${width}`);
    if (process.env.DIM_WEB_EVIDENCE) {
      await mkdir(process.env.DIM_WEB_EVIDENCE, { recursive: true });
      await page.screenshot({ path: `${process.env.DIM_WEB_EVIDENCE}/workspace-services-${width}.png`, fullPage: true });
    }
  }
  for (const { name, input } of calls.filter(({ name }) => name !== 'controllers.list')) assert.deepEqual({ controllerId: input.controllerId, workspace: input.workspace, workspaceId: input.workspaceId }, { controllerId: 'devbox', workspace: workspace.name, workspaceId: workspace.id }, name);
  assert.deepEqual(errors, []);
  console.log('Workspace tools to external access, actual shell/transport, uncertain create recovery, exact identity and responsive rendering PASS (synthetic host service responses).');
} finally { await browser.close(); await fixture.close(); }
