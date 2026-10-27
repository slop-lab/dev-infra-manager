import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {createNonGitWorkbench} from './non-git-workbench/harness.js';
import {WORKSPACE_IDS} from './non-git-workbench/state.js';
const executablePath=process.env.DIM_CHROMIUM;
if(!executablePath)throw new Error('DIM_CHROMIUM is required');
const fixture=await createNonGitWorkbench(),browser=await chromium.launch({executablePath,headless:true}),context=await browser.newContext();
let release:()=>void=()=>{};
try{
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:fixture.origin});
  const operator=await context.newPage(),login=await context.newPage();
  await login.goto(fixture.origin);await login.getByLabel('Username',{exact:true}).waitFor();
  await operator.goto(`${fixture.origin}/#/workspaces/local/${WORKSPACE_IDS.running}/tools`);
  await operator.getByLabel('Username',{exact:true}).fill(fixture.username);await operator.getByLabel('Password',{exact:true}).fill(fixture.password);await operator.getByRole('button',{name:'Sign in',exact:true}).click();
  await operator.getByRole('button',{name:'Copy server password',exact:true}).waitFor();await operator.evaluate(()=>navigator.clipboard.writeText('login-loss-sentinel'));
  let mark:()=>void=()=>{};const held=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{mark=resolve;});
  await operator.route('**/operations/server.credentials',async(route)=>{const response=await route.fetch();mark();await held;await route.fulfill({response});},{times:1});
  await operator.getByRole('button',{name:'Copy server password',exact:true}).click();await ready;
  await login.route('**/v1/session',async(route)=>{if(route.request().method()!=='POST'){await route.continue();return;}const response=await route.fetch();await route.fulfill({response,body:'{',contentType:'application/json'});},{times:1});
  await login.getByLabel('Username',{exact:true}).fill(fixture.readonlyUsername);await login.getByLabel('Password',{exact:true}).fill(fixture.password);await login.getByRole('button',{name:'Sign in',exact:true}).click();
  await login.locator('#login-error').getByText('Cannot reach this console.',{exact:false}).waitFor();
  await operator.locator('#login-view').waitFor({state:'visible'});
  const session:unknown=await (await context.request.get(`${fixture.origin}/v1/session`)).json();assert(session!==null&&typeof session==='object'&&'username'in session);assert.equal(session.username,fixture.readonlyUsername);
  release();await login.reload();await login.locator('#session-actions').waitFor({state:'visible'});
  assert.equal(await operator.evaluate(()=>navigator.clipboard.readText()),'login-loss-sentinel');
  assert.equal((await operator.locator('body').innerText()).includes('synthetic-only-password'),false);
  process.stdout.write('A login that changes the cookie but loses its body still fences prior operator tabs and delayed secrets.\n');
}finally{release();await browser.close();await fixture.close();}
