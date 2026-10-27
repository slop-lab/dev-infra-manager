import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createNonGitWorkbench} from './non-git-workbench/harness.js';
import {WORKSPACE_IDS} from './non-git-workbench/state.js';
const executablePath=process.env.DIM_CHROMIUM;
if(!executablePath) throw new Error('DIM_CHROMIUM is required');
const fixture=await createNonGitWorkbench(),browser=await chromium.launch({executablePath,headless:true}),page=await browser.newPage();
let reconnects=0;
let releaseCreate:()=>void=()=>{};
try{
  let catalogReads=0;
  await page.route('**/v1/extensions',async(route)=>{
    const response=await route.fetch(),body:unknown=await response.json();assert(Array.isArray(body));
    catalogReads++;
    await route.fulfill({json:body.map((feature:unknown)=>feature!==null&&typeof feature==='object'&&(catalogReads===1||'id'in feature&&feature.id==='external-urls')?{...feature,status:'unavailable'}:feature)});
  },{times:2});
  page.on('request',request=>{if(request.url().endsWith('/extensions/external-urls/reconnect'))reconnects++;});
  await page.goto(`${fixture.origin}/#/workspaces/local/${WORKSPACE_IDS.running}/tools`);
  await page.getByLabel('Username',{exact:true}).fill(fixture.readonlyUsername);await page.getByLabel('Password',{exact:true}).fill(fixture.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('link',{name:'Execution',exact:true}).click();
  await page.getByText('This feature connection is unavailable. Ask a browser operator to reconnect it; workspaces and other connected features remain available.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Reconnect feature',exact:true}).count(),0);
  await page.getByRole('link',{name:'Settings & access',exact:true}).click();
  await page.getByText('A browser operator must reconnect this fixed private connection.',{exact:true}).first().waitFor();
  for(const width of [375,768,1280]){await page.setViewportSize({width,height:812});assert.equal(await page.getByText('A browser operator must reconnect this fixed private connection.',{exact:true}).first().isVisible(),true);assert.equal(await page.getByRole('button',{name:/^Reconnect /}).count(),0);}
  assert.equal(reconnects,0);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByLabel('Username',{exact:true}).fill(fixture.username);await page.getByLabel('Password',{exact:true}).fill(fixture.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.goto(`${fixture.origin}/#/workspaces/local/${WORKSPACE_IDS.running}/tools`);
  const row=page.locator('.workspace-row:visible');
  await row.getByLabel('New server password',{exact:true}).fill('synthetic-only-draft');
  await row.getByRole('link',{name:'Routes',exact:true}).click();await row.getByText('This host feature is unavailable.',{exact:false}).waitFor();
  await page.getByRole('link',{name:'Settings & access',exact:true}).click();
  await page.getByRole('button',{name:'Reconnect External routes',exact:true}).click();
  await page.getByText('Connection reattested.',{exact:false}).waitFor();assert.equal(reconnects,1);
  await page.goto(`${fixture.origin}/#/workspaces/local/${WORKSPACE_IDS.running}/routes`);
  await row.getByRole('form',{name:'Create route for studio',exact:true}).waitFor();await row.getByText('Routes refreshed.',{exact:true}).waitFor();
  await row.getByRole('link',{name:'Tools',exact:true}).click();
  assert.equal((await row.getByLabel('New server password',{exact:true}).inputValue()).length,'synthetic-only-draft'.length);
  await row.getByRole('link',{name:'Routes',exact:true}).click();
  let createReady:()=>void=()=>{};const held=new Promise<void>(resolve=>{releaseCreate=resolve;}),ready=new Promise<void>(resolve=>{createReady=resolve;});
  await page.route('**/operations/routes.create',async(route)=>{const response=await route.fetch();createReady();await held;await route.fulfill({response});},{times:1});
  await row.getByLabel('Route name',{exact:true}).fill('reconnect-write');await row.getByRole('button',{name:'Create route',exact:true}).click();await ready;
  await page.getByRole('link',{name:'Settings & access',exact:true}).click();await page.getByRole('button',{name:'Reconnect External routes',exact:true}).click();await page.getByText('Connection reattested.',{exact:false}).waitFor();
  releaseCreate();await page.goto(`${fixture.origin}/#/workspaces/local/${WORKSPACE_IDS.running}/routes`);
  await row.getByText('Route change outcome is unknown.',{exact:false}).waitFor();assert.equal(await row.getByRole('button',{name:'Create route',exact:true}).isDisabled(),true);
  await row.getByRole('button',{name:'Refresh routes',exact:true}).click();await row.getByText('Awaiting operator approval.',{exact:false}).waitFor();assert.equal(reconnects,2);
  process.stdout.write('Workspace-only capability reconnect recovered its failed mount while preserving the healthy tools draft.\n');
}finally{releaseCreate();await browser.close();await fixture.close();}
