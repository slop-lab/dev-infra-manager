import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {llmWebFixture} from './fixture.js';
import {defaultLimits} from '../../../../packages/control-plane/plugins/llm-router/src/config.js';
const executablePath = process.env.DIM_CHROMIUM;
if (!executablePath) throw new Error('DIM_CHROMIUM is required');
const fixture = await llmWebFixture(), browser = await chromium.launch({executablePath,headless:true});
fixture.router.ledger.createProject('other',{allowedRoutes:['default'],limits:defaultLimits,captureMode:'required',tokenMode:'observe'});
const page = await browser.newPage();
let release:()=>void = ()=>{}, started:()=>void = ()=>{};
const held = new Promise<void>((resolve)=>{release=resolve;}), requested = new Promise<void>((resolve)=>{started=resolve;});
try {
  await page.route('**/operations/project.policy',async(route)=>{started();await held;await route.continue();},{times:1});
  await page.goto(`${fixture.origin}/#/settings`); await page.getByLabel('Username',{exact:true}).fill(fixture.username); await page.getByLabel('Password',{exact:true}).fill(fixture.password); await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('heading',{name:'Installed Web capabilities',exact:true}).waitFor();
  const pending = page.evaluate(`import('/assets/navigation-broker.js').then(({navigation})=>navigation.openFeature('llm-router',{kind:'project',projectId:'other'}))`);
  await requested;
  await page.getByRole('link',{name:'Workspaces',exact:true}).click();
  await page.waitForURL(/#\/workspaces$/);
  const response = page.waitForResponse((result)=>result.url().endsWith('/operations/project.policy'));
  release(); await (await response).finished();
  const outcome = await pending;
  assert(outcome !== null && typeof outcome==='object' && 'status' in outcome);
  assert.equal(outcome.status,'unavailable');
  assert.equal(new URL(page.url()).hash,'#/workspaces');
  assert.equal(await page.getByRole('heading',{name:'Project other',exact:true}).isVisible(),false);
  process.stdout.write('A pending related-project read cannot steal a newer native console destination or rewrite its URL.\n');
} finally {release();await browser.close();await fixture.close();}
