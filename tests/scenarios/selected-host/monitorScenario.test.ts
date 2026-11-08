import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { inspectConfiguredMonitor } from './monitorScenario.js';
import { ownedMonitorDefaults } from './config.js';

it('automatically binds default workspace monitoring to fresh owned team metadata and retains failclosed discovery',async()=>{
 let members=false;
 const server=createServer((request,response)=>{
  const values:Record<string,unknown>={'/experimental/tool/ids':['team_create'],'/session/status':members?{ses_child:{type:'busy'}}:{},'/session?limit=80':[{id:'ses_parent'}],'/session/ses_parent':{id:'ses_parent'},'/session/ses_parent/message?limit=12':[], '/session/ses_parent/children':[], '/question':[], '/permission':[], '/session/ses_failed/message?limit=12':[{info:{role:'assistant',error:{name:'UnknownError'}}}]};
  expect(request.headers.authorization).toBe(`Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`);
  const url=new URL(request.url!,'http://localhost');url.searchParams.delete('directory');
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(values[url.pathname+url.search]??[]));
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('missing listener');
 const workspace='fixture',workspaceId='11111111-1111-4111-8111-111111111111';
 let unavailable=false;
 const run=vi.fn(async(_step:string,args:readonly string[])=>{
  expect(args.slice(0,4)).toEqual(['tools','console','invoke','server.team-metadata']);expect(JSON.parse(args[5]!)).toEqual({workspace,workspaceId,directory:'/workspace'});
  return {stdout:JSON.stringify({workspace,workspaceId,source:unavailable?'unavailable':'optional-omo-adapter',enabled:unavailable?null:true,teams:members?[{leadSessionId:'ses_parent',status:'active',members:[{sessionId:'ses_child',status:'active'},{sessionId:'ses_failed',status:'failed'}],modifiedAt:'2026-11-08T16:00:00.000Z'}]:[],truncated:false,unreadable:unavailable}),stderr:'',exitCode:0};
 });
 try {
  const input={profile:ownedMonitorDefaults,workspace,workspaceId,endpoint:`http://127.0.0.1:${address.port}`,sessionId:'ses_parent',directory:'/workspace',credentials:{username:'opencode',password:'fixture-password'},run};
  expect(await inspectConfiguredMonitor(input)).toMatchObject({state:'idle',discovery:'complete-child-tree',teamToolInventory:'present'});
  members=true;expect(await inspectConfiguredMonitor(input)).toMatchObject({state:'active',activeChildren:1,currentFailures:1});members=false;
  unavailable=true;expect(await inspectConfiguredMonitor(input)).toMatchObject({state:'unknown',discovery:'partial'});expect(run).toHaveBeenCalledTimes(3);
  const explicit=vi.fn(async(_step:string,args:readonly string[])=>{expect(args).toEqual(['exec',workspace,'--','cat','/reviewed/metadata.json']);return {stdout:JSON.stringify({source:'optional-omo-adapter',enabled:true,teams:[],truncated:false,unreadable:false}),stderr:'',exitCode:0};});
  expect(await inspectConfiguredMonitor({...input,profile:{...ownedMonitorDefaults,omoMetadataPath:'/reviewed/metadata.json'},run:explicit})).toMatchObject({state:'idle',discovery:'complete-child-tree'});expect(explicit).toHaveBeenCalledTimes(1);expect(run).toHaveBeenCalledTimes(3);
 }finally{server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));}
});
