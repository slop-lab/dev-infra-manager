import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {z} from 'zod';
import {executionSummarySchema,executionDetailSchema,type ExecutionSummary} from '../../packages/contracts/ci/src/query.js';
import {createNonGitWorkbench} from './non-git-workbench/harness.js';
const executablePath=process.env.DIM_CHROMIUM;
if(!executablePath) throw new Error('DIM_CHROMIUM is required');
for(const outcome of ['accepted','unknown'] as const){
  const fixture=await createNonGitWorkbench(),browser=await chromium.launch({executablePath,headless:true}),page=await browser.newPage();
  let cancelled=false,failDetail=outcome==='accepted',calls=0,holdList=false;
  let queued:ExecutionSummary|undefined;
  let release:()=>void=()=>{},mark:()=>void=()=>{};
  const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{mark=resolve;});
  const recovering=(job:ExecutionSummary)=>executionSummarySchema.parse({...job,phase:'recovering',cancelRequestedAt:1});
  try{
    await page.route('**/extensions/execution/operations/jobs.list',async(route)=>{
      const response=await route.fetch(),rows=executionSummarySchema.array().parse(await response.json());
      queued=rows.find(job=>job.jobName==='browser-task');
      const snapshot=rows.map(job=>cancelled&&job.id===queued?.id?recovering(job):job);
      if(holdList){holdList=false;mark();await held;}
      await route.fulfill({json:snapshot});
    });
    await page.route('**/extensions/execution/operations/jobs.detail',async(route)=>{
      if(cancelled&&failDetail){await route.fulfill({status:503,json:{error:'synthetic detail unavailable'}});return;}
      const response=await route.fetch(),detail=executionDetailSchema.parse(await response.json());
      await route.fulfill({json:cancelled&&detail.job.id===queued?.id?{...detail,job:recovering(detail.job)}:detail});
    });
    await page.route('**/extensions/execution/operations/jobs.cancel',async(route)=>{
      const input=z.record(z.string(),z.unknown()).parse(route.request().postDataJSON());
      assert(queued);assert.equal(input.controllerId,'local');assert.equal(input.id,queued.id);
      calls++;cancelled=true;
      await route.fulfill(outcome==='unknown'?{status:503,json:{error:'synthetic lost accepted cancellation'}}:{json:recovering(queued)});
    });
    await page.goto(`${fixture.origin}/#/features/execution/controllers/local/jobs`);
    await page.getByLabel('Username',{exact:true}).fill(fixture.username);await page.getByLabel('Password',{exact:true}).fill(fixture.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByRole('link',{name:'browser-task',exact:true}).click();await page.getByRole('button',{name:'Cancel execution',exact:true}).waitFor();
    if(outcome==='unknown'){holdList=true;await page.getByRole('button',{name:'Refresh jobs',exact:true}).click();await started;}
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Cancel execution',exact:true}).click();
    if(outcome==='unknown'){
      await page.getByText('Cancel execution: outcome is unknown.',{exact:false}).waitFor();release();
      await page.getByText('An older job read did not reconcile the newer unknown cancellation.',{exact:false}).waitFor();
    }else await page.getByText(/^Cancellation accepted\..*could not refresh/).waitFor();
    assert.equal(await page.getByRole('button',{name:'Cancel execution',exact:true}).isDisabled(),true);assert.equal(calls,1);
    failDetail=false;await page.getByRole('button',{name:'Refresh jobs',exact:true}).click();
    await page.getByRole('heading',{name:'browser-task — recovering',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Cancel execution',exact:true}).count(),0);assert.equal(calls,1);
    process.stdout.write(`Execution ${outcome} cancellation stayed locked through stale/failed reads and refreshed current detail without replay.\n`);
  }finally{release();await browser.close();await fixture.close();}
}
