// @ts-check
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {{source:string,enabled:boolean|null,teams:{leadSessionId:string|null,status:string,members:{sessionId:string|null,status:string}[],modifiedAt:string}[],truncated:boolean,unreadable:boolean}} TeamMetadata */
const statuses = new Set(['active','running','creating','shutdown_requested','idle','busy','retry','errored','error','completed','stopped','pending','failed','shutdown','deleting','deleted']);
/** @param {unknown} value */
const status = value => typeof value === 'string' && statuses.has(value) ? value : 'unknown';
/** @param {unknown} value */
const id = value => typeof value === 'string' && /^ses_[A-Za-z0-9]{1,100}$/.test(value) ? value : null;
/** @param {unknown} value @returns {Record<string,unknown>} */
function record(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid record'); return Object.fromEntries(Object.entries(value)); }
/** @returns {TeamMetadata} */
const unavailable = () => ({source:'unavailable',enabled:null,teams:[],truncated:false,unreadable:true});
/** @param {unknown} error */
const missing = error => error instanceof Error && 'code' in error && error.code === 'ENOENT';
/** @param {string} path @param {number} maximum @param {AbortSignal} signal */
async function bytes(path,maximum,signal) {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1 || before.size > maximum) throw Error('unsafe file');
    const buffer = Buffer.alloc(maximum+1); let length=0;
    while (length < buffer.length) { signal.throwIfAborted(); const part = await file.read(buffer,length,buffer.length-length,null); if (!part.bytesRead) break; length+=part.bytesRead; }
    const after=await file.stat();
    if (length>maximum || before.dev!==after.dev || before.ino!==after.ino || before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs) throw Error('changing or oversized file');
    return buffer.subarray(0,length).toString('utf8');
  } finally { await file.close(); }
}
/** Reject symlinks in the full path; ancestor ownership may be root, final directory must be guest-owned.
 * @param {string} path @param {AbortSignal} signal */
async function directory(path,signal) {
  if (path==='/' || !isAbsolute(path) || resolve(path)!==path) throw Error('invalid directory');
  let current='/'; const parts=path.split('/').filter(Boolean);
  for (const [index,part] of parts.entries()) {
    signal.throwIfAborted(); current=join(current,part); const stat=await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || index===parts.length-1 && stat.uid!==process.getuid?.()) throw Error('unsafe directory');
  }
}
/** @param {{baseDirectory:string,maxRuns:number,maxMembers:number,deadlineMs:number,signal?:AbortSignal,allowAbsentRuntime?:boolean}} input @returns {Promise<TeamMetadata>} */
export async function readTeamRuntime(input) {
  const signal=AbortSignal.any([AbortSignal.timeout(input.deadlineMs),...(input.signal?[input.signal]:[])]);
  /** @type {TeamMetadata} */ const result={source:'optional-omo-adapter',enabled:null,teams:[],truncated:false,unreadable:false};
  if (!Number.isInteger(input.maxRuns)||input.maxRuns<1||input.maxRuns>80||!Number.isInteger(input.maxMembers)||input.maxMembers<1||input.maxMembers>80) return unavailable();
  try {
    await directory(input.baseDirectory,signal);
    const runtime=join(input.baseDirectory,'runtime');
    try { await directory(runtime,signal); } catch(error) { if (missing(error)&&input.allowAbsentRuntime) return result; throw error; }
    let count=0,remaining=input.maxMembers;
    const runs=await opendir(runtime);
    for await (const entry of runs) {
      signal.throwIfAborted();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.name)) {result.unreadable=true;continue;}
      if (count++>=input.maxRuns) {result.truncated=true;break;}
      const path=join(runtime,entry.name);
      try {
        await directory(path,signal);
        const file=join(path,'state.json'), state=record(JSON.parse(await bytes(file,1024*1024,signal)));
        if (state.version!==1 || typeof state.teamRunId!=='string' || state.teamRunId!==entry.name || !Array.isArray(state.members)) throw Error('invalid runtime');
        const metadata=await lstat(file); const members=[];
        if (state.members.length>remaining) result.truncated=true;
        for (const raw of state.members.slice(0,remaining)) {const member=record(raw);const sessionId=id(member.sessionId), activity=status(member.status);if(sessionId===null||activity==='unknown')result.unreadable=true;members.push({sessionId,status:activity});}
        remaining-=members.length;
        const leadSessionId=id(state.leadSessionId), activity=status(state.status);if(leadSessionId===null||activity==='unknown')result.unreadable=true;
        result.teams.push({leadSessionId,status:activity,members,modifiedAt:metadata.mtime.toISOString()});
      } catch {result.unreadable=true;}
    }
    signal.throwIfAborted();return result;
  } catch {return unavailable();}
}

/** Deliberately supports only the known DIM-managed config shape, not a second OMO precedence engine.
 * @param {Record<string,unknown>} config @param {string} home */
export function managedTeamConfig(config,home) {
  const known=(/** @type {Record<string,unknown>} */ value,/** @type {string[]} */ keys)=>{if(Object.keys(value).some(key=>!keys.includes(key)))throw Error('unsupported configuration');};
  known(config,['team_mode','[opencode]']);
  const harness=config['[opencode]']===undefined?{}:record(config['[opencode]']); known(harness,['auto_update','team_mode']);
  if(harness.auto_update!==undefined&&harness.auto_update!==false)throw Error('unsupported automatic update');
  const base=config.team_mode===undefined?{}:record(config.team_mode), override=harness.team_mode===undefined?{}:record(harness.team_mode);
  for(const layer of [base,override]){
    known(layer,['enabled','max_parallel_members','max_members','tmux_visualization','base_dir']);
    if(layer.enabled!==undefined&&typeof layer.enabled!=='boolean'||layer.tmux_visualization!==undefined&&typeof layer.tmux_visualization!=='boolean')throw Error('invalid team mode');
    // These are the exact bounds emitted by normal DIM setup. Advanced configurations remain explicitly observable only through an adapter.
    if(layer.max_parallel_members!==undefined&&layer.max_parallel_members!==4||layer.max_members!==undefined&&layer.max_members!==8)throw Error('unsupported bounds');
    if(layer.base_dir!==undefined&&(typeof layer.base_dir!=='string'||!layer.base_dir||/[\x00-\x1f\x7f]/.test(layer.base_dir)))throw Error('invalid base');
  }
  const team={...base,...override};if(typeof team.enabled!=='boolean')throw Error('team configuration not established');
  const selectedPath=team.base_dir??join(home,'.omo');if(typeof selectedPath!=='string')throw Error('invalid base');
  let path=selectedPath;
  if(path==='~')path=home;else if(path.startsWith('~/')||path.startsWith('~\\'))path=join(home,path.slice(2));
  if(!isAbsolute(path)||resolve(path)!==path)throw Error('unsupported relative base');
  return {baseDirectory:path,enabled:team.enabled};
}

/** @param {string} home @param {string} cwd @param {Record<string,string|undefined>} environment @param {(source:string)=>unknown} parse @param {AbortSignal} signal */
async function managedContext(home,cwd,environment,parse,signal) {
  if ([environment.OMO_PROFILE,environment.OCX_PROFILE,environment.OPENCODE_CONFIG_DIR,environment.OPENCODE_CONFIG].some(value=>value)) throw Error('profile context needs explicit adapter');
  await directory(home,signal);await directory(cwd,signal);
  const configHome=environment.XDG_CONFIG_HOME||join(home,'.config');await directory(configHome,signal);
  const exactPlugin=pathToFileURL(join(home,'.local/lib/node_modules/oh-my-openagent/dist/index.js')).href;
  const routerPlugin=pathToFileURL(join(configHome,'opencode/plugins/dim-llm-router.mjs')).href;
  const hash=createHash('sha256').update('DIM managed OMO metadata context v1\0');
  let configBytes=0;
  const readConfig=async(/** @type {string} */ file)=>{const source=await bytes(file,1024*1024,signal);configBytes+=Buffer.byteLength(source);if(configBytes>2*1024*1024)throw Error('configuration byte limit');return source;};
  const plugins=(/** @type {unknown} */ value,/** @type {boolean} */ required)=>{
    if(value===undefined&&!required)return;
    if(!Array.isArray(value)||required&&!value.includes(exactPlugin)||value.some(entry=>entry!==exactPlugin&&entry!==routerPlugin))throw Error('unproven plugin selection');
  };
  const optionalConfig=async(/** @type {string} */ file,/** @type {boolean} */ global)=>{
    try {
      const source=await readConfig(file), value=record(parse(source));
      if(global&&Object.keys(value).some(key=>key!=='plugin'&&key!=='autoupdate'))throw Error('unsupported user OpenCode config');
      if(global&&value.autoupdate!==false)throw Error('unpinned OpenCode update');
      plugins(value.plugin,global);hash.update(file).update(source);return true;
    }catch(error){if(!missing(error))throw error;hash.update(file).update('absent');return false;}
  };
  if(environment.OPENCODE_CONFIG_CONTENT){const value=record(JSON.parse(environment.OPENCODE_CONFIG_CONTENT));plugins(value.plugin,false);hash.update(environment.OPENCODE_CONFIG_CONTENT);}
  let globals=0;await directory(join(configHome,'opencode'),signal);
  for(const name of ['opencode.json','opencode.jsonc'])if(await optionalConfig(join(configHome,'opencode',name),true))globals++;
  if(!globals)throw Error('pinned plugin selection is not established');
  let current=cwd;
  for(let depth=0;;depth++) {
    if(depth>=256)throw Error('project depth');
    if(current!==home) {
      const config=join(current,'.omo');
      try {const info=await lstat(config);if(info.isSymbolicLink()||!info.isDirectory())throw Error('ambiguous project config');
        for(const name of ['omo.jsonc','omo.json'])try{await lstat(join(config,name));throw Error('project configuration needs explicit adapter');}catch(error){if(!missing(error))throw error;}
      }catch(error){if(!missing(error))throw error;}
      for(const name of ['opencode.json','opencode.jsonc'])await optionalConfig(join(current,name),false);
      const hidden=join(current,'.opencode');
      try {await directory(hidden,signal);for(const name of ['opencode.json','opencode.jsonc'])await optionalConfig(join(hidden,name),false);}catch(error){if(!missing(error))throw error;}
    }
    if(current===home||dirname(current)===current)break;current=dirname(current);
  }
  const user=join(home,'.omo');await directory(user,signal);
  let file=join(user,'omo.jsonc');try{await lstat(file);}catch(error){if(!missing(error))throw error;file=join(user,'omo.json');}
  const source=await readConfig(file), selected=managedTeamConfig(record(parse(source)),home);
  return {...selected,fingerprint:hash.update(file).update(source).digest('hex')};
}
/** @param {string} home @param {AbortSignal} signal */
async function installedParser(home,signal) {
  const require=createRequire(import.meta.url), modules=join(home,'.local/lib/node_modules');
  for(const [name,version] of /** @type {[string,string][]} */ ([['oh-my-openagent','4.19.4'],['jsonc-parser','3.3.1']])){
    await directory(join(modules,name),signal);const metadata=record(JSON.parse(await bytes(join(modules,name,'package.json'),65536,signal)));
    if(metadata.name!==name||metadata.version!==version)throw Error('unsupported installed tool');
  }
  const parser=require(join(modules,'jsonc-parser'));
  return (/** @type {string} */ source)=>{const errors=/** @type {unknown[]} */ ([]);const value=parser.parse(source.charCodeAt(0)===0xfeff?source.slice(1):source,errors,{allowTrailingComma:true,disallowComments:false});if(errors.length)throw Error('invalid JSONC');return value;};
}
/** Called only after the normal launch hook, before exec. No file or desired-state marker is written.
 * @param {{home:string,cwd:string,environment:Record<string,string|undefined>}} input */
export async function launchTeamFingerprint(input) {
  try {const signal=AbortSignal.timeout(5000);return (await managedContext(input.home,input.cwd,input.environment,await installedParser(input.home,signal),signal)).fingerprint;}
  catch{return 'unavailable';}
}
/** @param {string} source */
const birth=source=>{const fields=source.slice(source.lastIndexOf(')')+2).trim().split(/\s+/);if(fields[0]==='Z'||!/^\d+$/.test(fields[19]??''))throw Error('invalid process');return fields[19];};
/** @param {{home:string,procRoot?:string,directory?:string}} input @param {AbortSignal} signal */
async function ownedServerContext(input,signal) {
    const home=resolve(input.home);await directory(home,signal);
    const settings=record(JSON.parse(await bytes(join(home,'.local/state/dim-agent-tools/opencode-service.json'),32768,signal)));
    if(typeof settings.stateHome!=='string'||!isAbsolute(settings.stateHome)||relative(home,settings.stateHome).startsWith('..'))throw Error('unsafe state root');
    await directory(join(settings.stateHome,'opencode-web'),signal);
    const pidFile=join(settings.stateHome,'opencode-web/server.pid'), pidText=await bytes(pidFile,512,signal);
    const match=/^(\d+) (\d+) (\d+) ([a-f0-9]{64})\n?$/.exec(pidText);if(!match||!match[1]||!match[2]||!match[4]||match[3]!==settings.port)throw Error('unknown server');
    const processPath=join(input.procRoot??'/proc',match[1]);
    if(birth(await bytes(join(processPath,'stat'),8192,signal))!==match[2])throw Error('replaced process');
    const environment=Object.fromEntries((await bytes(join(processPath,'environ'),128*1024,signal)).split('\0').filter(entry=>['HOME=','DIM_OPENCODE_WEB_INSTANCE_ID=','OMO_PROFILE=','OCX_PROFILE=','OPENCODE_CONFIG_DIR=','OPENCODE_CONFIG=','OPENCODE_CONFIG_CONTENT=','XDG_CONFIG_HOME=','DIM_OPENCODE_WEB_OMO_CONFIG_SHA256='].some(prefix=>entry.startsWith(prefix))).map(entry=>{const at=entry.indexOf('=');return[entry.slice(0,at),entry.slice(at+1)];}));
    if(environment.HOME!==home||environment.DIM_OPENCODE_WEB_INSTANCE_ID!==match[4])throw Error('unowned process');
    const cwd=await readlink(join(processPath,'cwd'));
    if(input.directory!==undefined&&(input.directory!==cwd||resolve(input.directory)!==input.directory))throw Error('session directory differs from owned server');
    return {home,pidFile,pidText,match,processPath,environment,cwd};
}
/** @param {{home:string,procRoot?:string,signal?:AbortSignal}} input */
export async function inspectOwnedServerIdentity(input) {
  const signal=AbortSignal.any([AbortSignal.timeout(5000),...(input.signal?[input.signal]:[])]);
  const context=await ownedServerContext(input,signal);
  return {directory:context.cwd,port:Number(context.match[3]),identity:createHash('sha256').update(context.pidText).update('\0').update(context.cwd).digest('hex')};
}
/** @param {{home:string,procRoot?:string,signal?:AbortSignal,directory?:string}} input @returns {Promise<TeamMetadata>} */
export async function inspectServerTeamMetadata(input) {
  const signal=AbortSignal.any([AbortSignal.timeout(5000),...(input.signal?[input.signal]:[])]);
  try {
    const {home,pidFile,pidText,match,processPath,environment,cwd}=await ownedServerContext(input,signal);
    const parse=await installedParser(home,signal), selected=await managedContext(home,cwd,environment,parse,signal);
    if(!/^[a-f0-9]{64}$/.test(environment.DIM_OPENCODE_WEB_OMO_CONFIG_SHA256??'')||selected.fingerprint!==environment.DIM_OPENCODE_WEB_OMO_CONFIG_SHA256)throw Error('configuration changed after launch');
    const result=await readTeamRuntime({...selected,maxRuns:16,maxMembers:80,deadlineMs:5000,signal,allowAbsentRuntime:true});
    if((await managedContext(home,cwd,environment,parse,signal)).fingerprint!==selected.fingerprint)throw Error('configuration changed during inspection');
    if(await readlink(join(processPath,'cwd'))!==cwd)throw Error('server directory changed during inspection');
    if(await bytes(pidFile,512,signal)!==pidText||birth(await bytes(join(processPath,'stat'),8192,signal))!==match[2])throw Error('changed server');
    return {...result,enabled:selected.enabled};
  } catch {return unavailable();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.length===3&&process.argv[2]==='--launch-fingerprint') process.stdout.write(await launchTeamFingerprint({home:process.env.HOME??'',cwd:process.cwd(),environment:process.env}));
  else if(process.argv.length===3&&process.argv[2]==='--server-identity') {
    try {process.stdout.write(JSON.stringify(await inspectOwnedServerIdentity({home:process.env.HOME??''}))+'\n');}
    catch {process.stderr.write('Owned OpenCode identity unavailable\n');process.exitCode=1;}
  }
  else if(process.argv.length===2){
    let input='';for await(const chunk of process.stdin){input+=chunk.toString();if(Buffer.byteLength(input)>8192)throw Error('metadata input limit');}
    const request=input?record(JSON.parse(input)):{};if(Object.keys(request).some(key=>key!=='directory')||(request.directory!==undefined&&(typeof request.directory!=='string'||!isAbsolute(request.directory)||/[\x00-\x1f\x7f]/.test(request.directory))))throw Error('invalid metadata input');
    const result=await inspectServerTeamMetadata({home:process.env.HOME??'',...(typeof request.directory==='string'?{directory:request.directory}:{})});process.stdout.write(JSON.stringify(result)+'\n');
  }
  else process.exitCode=2;
}
