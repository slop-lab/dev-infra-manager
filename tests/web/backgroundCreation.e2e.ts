import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createOperationsBrowserFixture} from './operationsBrowserFixture.js';
import {llmWebFixture} from './plugins/llm-router/fixture.js';
const executablePath=process.env.DIM_CHROMIUM;
if(!executablePath)throw new Error('DIM_CHROMIUM is required');
const browser=await chromium.launch({executablePath,headless:true});
try { for(const kind of ['workspace','project'] as const){
  const fixture=kind==='workspace'?await createOperationsBrowserFixture():await llmWebFixture();
  const page=await browser.newPage();let release:()=>void=()=>{};
  try{
    let mark:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{mark=resolve;});
    const endpoint=kind==='workspace'?'**/workspaces/create':'**/operations/project.create';
    await page.route(endpoint,async(route)=>{const response=await route.fetch();assert.equal(response.status(),200);mark();await held;await route.fulfill({response});},{times:1});
    await page.goto(fixture.origin);await page.getByLabel('Username',{exact:true}).fill(fixture.username);await page.getByLabel('Password',{exact:true}).fill(fixture.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
    if(kind==='workspace'){
      await page.getByRole('link',{name:'New workspace on devbox',exact:true}).click();
      await page.getByLabel('Git URL or dim://PROJECT on devbox',{exact:true}).fill('https://example.test/background.git');await page.getByLabel('Workspace name on devbox',{exact:true}).fill('background-created');await page.getByRole('button',{name:'Create workspace on devbox',exact:true}).click();
    }else{
      await page.getByRole('link',{name:'LLM router',exact:true}).click();await page.getByRole('link',{name:'Projects & policy',exact:true}).click();await page.getByText('New routing project',{exact:true}).click();await page.getByLabel('Project ID',{exact:true}).fill('background-project');
      await page.waitForFunction(()=>{const route=document.querySelector('select[aria-label="Project route"]');return route instanceof HTMLSelectElement&&route.value!=='';});await page.getByRole('button',{name:'Create routing project',exact:true}).click();
    }
    await ready;await page.getByRole('link',{name:'Settings & access',exact:true}).click();await page.getByRole('heading',{name:'Installed Web capabilities',exact:true}).waitFor();
    const response=page.waitForResponse((result)=>result.url().endsWith(kind==='workspace'?'/workspaces/create':'/operations/project.create'));
    release();await(await response).finished();
    await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]')&&!document.querySelector('button[data-pending="true"]'));
    assert.equal(new URL(page.url()).hash,'#/settings');
    if('workspaceNamed'in fixture)assert(await fixture.workspaceNamed('background-created'));
    else assert.equal(fixture.router.ledger.project('background-project').id,'background-project');
    process.stdout.write(`Accepted background ${kind} creation retained the newer browser task without replay or forced navigation.\n`);
  }finally{release();await page.close();await fixture.close();}
} } finally { await browser.close(); }
