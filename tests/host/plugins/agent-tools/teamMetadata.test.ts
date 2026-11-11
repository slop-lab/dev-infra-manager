import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectOwnedServerIdentity, inspectServerTeamMetadata, launchTeamFingerprint, managedTeamConfig, readTeamRuntime } from '../../../../packages/host/plugins/agent-tools/src/assets/opencode-team-metadata.mjs';

const roots: string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})))});
async function root(){const value=await mkdtemp(join(tmpdir(),'dim-team-observe-'));roots.push(value);return value;}
async function state(base:string,run:string,extra:Record<string,unknown>={}){await mkdir(join(base,'runtime',run),{recursive:true,mode:0o700});await writeFile(join(base,'runtime',run,'state.json'),JSON.stringify({version:1,teamRunId:run,leadSessionId:'ses_parent',status:'active',members:[{sessionId:'ses_child',status:'running',prompt:'PRIVATE'}],...extra}),{mode:0o600});}
it('reads fresh bounded runtime files, preserves failed members and never invokes cleanup or exposes payloads',async()=>{
 const base=await root();await state(base,'one');await state(base,'two',{status:'failed',members:[{sessionId:'ses_failed',status:'failed',output:'PRIVATE'}]});
 const options={baseDirectory:base,maxRuns:80,maxMembers:80,deadlineMs:5000};
 const first=await readTeamRuntime(options);expect(first.unreadable).toBe(false);expect(first.teams.flatMap(t=>t.members)).toContainEqual({sessionId:'ses_failed',status:'failed'});expect(JSON.stringify(first)).not.toContain('PRIVATE');
 await state(base,'one',{status:'stopped',members:[]});const next=await readTeamRuntime(options);expect(next.teams.find(t=>t.leadSessionId==='ses_parent'&&t.status==='stopped')).toBeDefined();expect(await readFile(join(base,'runtime/two/state.json'),'utf8')).toContain('failed');
 await state(base,'one');
 expect((await readTeamRuntime({...options,maxRuns:1})).truncated).toBe(true);
 expect((await readTeamRuntime({...options,maxMembers:1})).truncated).toBe(true);
});
it('requires a proven base for absent runtime and treats unsafe, oversized and cancelled state as unreadable',async()=>{
 const base=await root(), options={baseDirectory:base,maxRuns:80,maxMembers:80,deadlineMs:5000};
 expect((await readTeamRuntime({...options,baseDirectory:'/',allowAbsentRuntime:true})).source).toBe('unavailable');
 expect((await readTeamRuntime(options)).source).toBe('unavailable');expect(await readTeamRuntime({...options,allowAbsentRuntime:true})).toMatchObject({source:'optional-omo-adapter',unreadable:false,teams:[]});
 await state(base,'one');await writeFile(join(base,'runtime/one/state.json'),'x'.repeat(1024*1024+1),{mode:0o600});expect((await readTeamRuntime(options)).unreadable).toBe(true);
 await rm(join(base,'runtime'),{recursive:true});const foreign=await root();await symlink(foreign,join(base,'runtime'));expect((await readTeamRuntime({...options,allowAbsentRuntime:true})).unreadable).toBe(true);
 expect((await readTeamRuntime({...options,signal:AbortSignal.abort()})).source).toBe('unavailable');
});
it('resolves the known managed base override in harness order, rejects ambiguous configuration instead of guessing',()=>{
 expect(managedTeamConfig({'[opencode]':{auto_update:false,team_mode:{enabled:true,max_parallel_members:4,max_members:8,tmux_visualization:false}}},'/home/dim')).toEqual({baseDirectory:'/home/dim/.omo',enabled:true});
 expect(managedTeamConfig({team_mode:{enabled:true,base_dir:'/tmp/base'},'[opencode]':{team_mode:{base_dir:'~/teams'}}},'/home/dim')).toEqual({baseDirectory:'/home/dim/teams',enabled:true});
 for(const config of [{profiles:{}},{'[opencode]':{team_mode:{enabled:true,base_dir:'relative'}}},{'[opencode]':{team_mode:{enabled:'true'}}}])expect(()=>managedTeamConfig(config,'/home/dim')).toThrow();
});
it.each([false,true])('binds actual pinned-parser inspection and base override %s to owned server; rejects ambiguity, changed config and PID',async(override)=>{
 const base=await root(),home=join(base,'home'),cwd=join(home,'project'),proc=join(base,'proc'),pid='12345',instance='a'.repeat(64);
 await mkdir(join(home,'.omo'),{recursive:true,mode:0o700});await mkdir(cwd,{mode:0o700});await mkdir(join(home,'.local/state/dim-agent-tools'),{recursive:true,mode:0o700});await mkdir(join(home,'.local/state/opencode-web'),{recursive:true,mode:0o700});await mkdir(join(proc,pid),{recursive:true,mode:0o700});
 await writeFile(join(home,'.local/state/dim-agent-tools/opencode-service.json'),JSON.stringify({port:'4096',stateHome:join(home,'.local/state'),corsOrigins:[]}),{mode:0o600});
 const config=join(home,'.omo/omo.jsonc'), teams=join(home,'teams');if(override){await mkdir(teams,{mode:0o700});await state(teams,'real-run');}
 await writeFile(config,'// pinned JSONC parser\n'+JSON.stringify({'[opencode]':{auto_update:false,team_mode:{enabled:true,...(override?{base_dir:teams}:{})}}}),{mode:0o600});
 const modules=join(home,'.local/lib/node_modules');await mkdir(join(modules,'oh-my-openagent'),{recursive:true,mode:0o700});await writeFile(join(modules,'oh-my-openagent/package.json'),JSON.stringify({name:'oh-my-openagent',version:'4.19.4'}),{mode:0o600});
 await cp(dirname(createRequire(import.meta.url).resolve('jsonc-parser/package.json')),join(modules,'jsonc-parser'),{recursive:true});await chmod(join(modules,'jsonc-parser'),0o755);await chmod(join(modules,'jsonc-parser/package.json'),0o644);
 await mkdir(join(home,'.config/opencode'),{recursive:true,mode:0o700});
 const exactPlugin=new URL(`file://${join(modules,'oh-my-openagent/dist/index.js')}`).href;
 await writeFile(join(home,'.config/opencode/opencode.json'),JSON.stringify({autoupdate:false,plugin:[exactPlugin]}),{mode:0o600});
 await writeFile(join(cwd,'opencode.json'),JSON.stringify({provider:{fixture:{}},model:'fixture/model',agent:{fixture:{mode:'primary'}}}),{mode:0o600});
 // Fast first launch: no sleep or timestamp tolerance. A hash, not a clock guess, binds the configuration.
 const content=JSON.stringify({provider:{fixture:{options:{apiKey:'PRIVATE'}}},plugin:[new URL(`file://${join(home,'.config/opencode/plugins/dim-llm-router.mjs')}`).href]});
 const fingerprint=await launchTeamFingerprint({home,cwd,environment:{HOME:home,OPENCODE_CONFIG_CONTENT:content}});expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
 const ticks='123456';const stat=()=>`${pid} (opencode) S ${Array(18).fill('0').join(' ')} ${ticks} 0`;
 await writeFile(join(proc,pid,'stat'),stat(),{mode:0o600});await writeFile(join(home,'.local/state/opencode-web/server.pid'),`${pid} ${ticks} 4096 ${instance}\n`,{mode:0o600});await symlink(cwd,join(proc,pid,'cwd'));
 const environment=(extra='',snapshot=fingerprint)=>writeFile(join(proc,pid,'environ'),`HOME=${home}\0DIM_OPENCODE_WEB_INSTANCE_ID=${instance}\0OPENCODE_SERVER_PASSWORD=PRIVATE\0OPENCODE_CONFIG_CONTENT=${content}\0${snapshot?`DIM_OPENCODE_WEB_OMO_CONFIG_SHA256=${snapshot}\0`:''}${extra}`,{mode:0o600});await environment();
 const inspect=()=>inspectServerTeamMetadata({home,procRoot:proc});expect((await inspectServerTeamMetadata({home,procRoot:proc,directory:home})).source).toBe('unavailable');
  const initial=await inspectServerTeamMetadata({home,procRoot:proc,directory:cwd});expect(initial).toMatchObject({source:'optional-omo-adapter',enabled:true,unreadable:false});expect(initial.teams).toHaveLength(override?1:0);
  const owned=await inspectOwnedServerIdentity({home,procRoot:proc});expect(owned).toMatchObject({directory:cwd,port:4096,identity:expect.stringMatching(/^[a-f0-9]{64}$/)});expect(JSON.stringify(owned)).not.toContain('PRIVATE');
  await writeFile(join(home,'.local/state/opencode-web/server.pid'),`${pid} ${ticks} 4096 ${'b'.repeat(64)}\n`,{mode:0o600});await environment(`DIM_OPENCODE_WEB_INSTANCE_ID=${'b'.repeat(64)}\0`);
  expect((await inspectOwnedServerIdentity({home,procRoot:proc})).identity).not.toBe(owned.identity);
  await writeFile(join(home,'.local/state/opencode-web/server.pid'),`${pid} ${ticks} 4096 ${instance}\n`,{mode:0o600});await environment();
 await environment('','');expect((await inspect()).source).toBe('unavailable');
 await environment('OPENCODE_CONFIG=/other/config\0');expect((await inspect()).source).toBe('unavailable');
 await environment('OPENCODE_CONFIG_CONTENT={"plugin":["oh-my-openagent@0.0.0"]}\0');expect((await inspect()).source).toBe('unavailable');
 await environment('OMO_PROFILE=custom\0');expect((await inspect()).source).toBe('unavailable');await environment();
 await mkdir(join(cwd,'.omo'),{mode:0o700});await writeFile(join(cwd,'.omo/omo.jsonc'),'{}',{mode:0o600});expect((await inspect()).source).toBe('unavailable');await rm(join(cwd,'.omo'),{recursive:true});
 await writeFile(config,JSON.stringify({'[opencode]':{team_mode:{enabled:true,base_dir:home}}}),{mode:0o600});expect((await inspect()).source).toBe('unavailable');
  await writeFile(join(proc,pid,'stat'),stat().replace(ticks,String(Number(ticks)+1)),{mode:0o600});expect((await inspect()).source).toBe('unavailable');
  await expect(inspectOwnedServerIdentity({home,procRoot:proc})).rejects.toThrow('replaced process');
 expect(JSON.stringify(await inspect())).not.toContain('PRIVATE');
});
