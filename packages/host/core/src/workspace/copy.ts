export const workspaceCopyMarker = "dim-workspace-copy";

export const workspaceCopyGuest = String.raw`
const fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path");
const [direction,operand,recursiveFlag,overwriteFlag,marker,role,token]=process.argv.slice(1);
const recursive=recursiveFlag==="1",overwrite=overwriteFlag==="1",magic=Buffer.from("DIMCP1\0","ascii");
const target=path.resolve(operand),parent=path.dirname(target);
const staging=path.join(parent,".dim-copy-"+token),stage=path.join(staging,"payload"),backup=path.join(parent,".dim-copy-backup-"+token);
const maxEntries=100000,maxHeaders=16*1024*1024,maxPayload=64*1024*1024*1024,maxPath=4096,maxTarget=4096;
let backedUp=false;
const fail=(message)=>{throw new Error(message)};
const exists=async(file)=>{try{await fsp.lstat(file);return true}catch(error){if(error&&error.code==="ENOENT")return false;throw error}};
const inside=(root,candidate)=>{const relative=path.relative(root,candidate);return relative===""||(relative!==".."&&!relative.startsWith(".."+path.sep))};
const frame=(entry)=>{const encoded=Buffer.from(JSON.stringify(entry)),length=Buffer.alloc(4);length.writeUInt32BE(encoded.length);return Buffer.concat([length,encoded])};
async function write(buffer){if(!process.stdout.write(buffer))await new Promise(resolve=>process.stdout.once("drain",resolve))}
async function pack(absolute,relative,root){
  const info=await fsp.lstat(absolute);
  if(info.isDirectory()){
    await write(frame({path:relative,type:"directory",mode:info.mode&511}));
    const entries=await fsp.readdir(absolute,{withFileTypes:true});entries.sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries)await pack(path.join(absolute,entry.name),relative==="."?entry.name:relative+"/"+entry.name,root);
    return;
  }
  if(info.isFile()){
    if(info.nlink!==1)fail("refusing to copy hard-linked file '"+relative+"'");
    await write(frame({path:relative,type:"file",mode:info.mode&511,size:info.size}));
    for await(const chunk of fs.createReadStream(absolute))await write(chunk);
    return;
  }
  if(info.isSymbolicLink()){
    const link=await fsp.readlink(absolute);let resolved;try{resolved=await fsp.realpath(absolute)}catch(error){throw new Error("refusing unresolved symlink '"+relative+"'",{cause:error})}
    if(!inside(root,resolved))fail("refusing escaping symlink '"+relative+"'");if(!link||Buffer.byteLength(link)>maxTarget||link.includes("\0")||link.includes("\\")||/^[A-Za-z]:/.test(link)||link.startsWith("//")||path.posix.isAbsolute(link))fail("refusing nonportable symlink '"+relative+"'");
    await write(frame({path:relative,type:"symlink",mode:info.mode&511,target:link}));return;
  }
  fail("refusing special file '"+relative+"'");
}
class Reader{
  constructor(input){this.iterator=input[Symbol.asyncIterator]();this.buffer=Buffer.alloc(0);this.entries=0;this.headers=0;this.payload=0}
  async take(length){while(this.buffer.length<length){const next=await this.iterator.next();if(next.done)fail("copy archive ended unexpectedly");const chunk=Buffer.isBuffer(next.value)?next.value:Buffer.from(next.value);this.buffer=Buffer.concat([this.buffer,chunk])}const result=this.buffer.subarray(0,length);this.buffer=this.buffer.subarray(length);return result}
  async start(){if(!(await this.take(magic.length)).equals(magic))fail("invalid copy archive header")}
  async entry(){const length=(await this.take(4)).readUInt32BE();if(length===0)return;if(length>65536)fail("copy archive entry header is too large");this.entries++;this.headers+=length;if(this.entries>maxEntries)fail("copy archive has too many entries");if(this.headers>maxHeaders)fail("copy archive headers exceed their size limit");let entry;try{entry=JSON.parse((await this.take(length)).toString("utf8"))}catch{fail("invalid copy archive entry")}if(entry&&entry.type==="file"&&Number.isSafeInteger(entry.size)&&entry.size>=0){this.payload+=entry.size;if(this.payload>maxPayload)fail("copy archive payload exceeds its size limit")}return entry}
  async file(output,size){const stream=fs.createWriteStream(output,{flags:"wx",mode:384});let remaining=size;try{while(remaining>0){const chunk=await this.take(Math.min(remaining,65536));remaining-=chunk.length;if(!stream.write(chunk))await new Promise((resolve,reject)=>{stream.once("drain",resolve);stream.once("error",reject)})}stream.end();await new Promise((resolve,reject)=>{stream.once("close",resolve);stream.once("error",reject)})}finally{stream.destroy()}}
  async end(){if(this.buffer.length!==0)fail("copy archive has trailing data");for(;;){const next=await this.iterator.next();if(next.done)return;const chunk=Buffer.isBuffer(next.value)?next.value:Buffer.from(next.value);if(chunk.length!==0)fail("copy archive has trailing data")}}
}
function validate(entry,first,seen){
  if(!entry||typeof entry!=="object"||Array.isArray(entry)||typeof entry.path!=="string"||Buffer.byteLength(entry.path)>maxPath||entry.path.includes("\0")||typeof entry.type!=="string"||!Number.isInteger(entry.mode)||entry.mode<0||entry.mode>511)fail("invalid copy archive entry");
  if(first!==(entry.path===".")||entry.path.includes("\\")||entry.path.startsWith("/")||(entry.path!=="."&&entry.path.split("/").some(part=>!part||part==="."||part==="..")))fail("unsafe copy archive path '"+entry.path+"'");
  if(seen.has(entry.path))fail("duplicate copy archive path '"+entry.path+"'");
  if(entry.type==="file"&&(!Number.isSafeInteger(entry.size)||entry.size<0))fail("invalid copy archive file");
  if(entry.type==="symlink"){
    const resolved=typeof entry.target==="string"?path.posix.normalize(path.posix.join(path.posix.dirname(entry.path),entry.target)):"..";
    if(typeof entry.target!=="string"||entry.target.length===0||Buffer.byteLength(entry.target)>maxTarget||entry.target.includes("\0")||entry.target.includes("\\")||/^[A-Za-z]:/.test(entry.target)||entry.target.startsWith("//")||entry.path==="."||path.posix.isAbsolute(entry.target)||resolved===".."||resolved.startsWith("../"))fail("unsafe copy archive symlink '"+entry.path+"'");
  }else if(entry.type!=="file"&&entry.type!=="directory")fail("unsupported copy archive entry type");
  seen.set(entry.path,entry.type);
}
async function receive(){
  await fsp.mkdir(parent,{recursive:true});
  if(!overwrite&&await exists(target))fail("copy destination already exists; use --overwrite");
  await fsp.mkdir(staging,{mode:448});
  const reader=new Reader(process.stdin);await reader.start();const seen=new Map(),directories=[];let first=true;
  for(;;){const entry=await reader.entry();if(entry===undefined)break;validate(entry,first,seen);first=false;
    const output=entry.path==="."?stage:path.join(stage,...entry.path.split("/"));
    if(entry.path!=="."){const parentEntry=path.posix.dirname(entry.path);if(seen.get(parentEntry==="."?".":parentEntry)!=="directory")fail("archive parent is not a directory")}
    if(entry.type==="directory"){await fsp.mkdir(output,{mode:448});directories.push({path:output,mode:entry.mode})}else if(entry.type==="symlink")await fsp.symlink(entry.target,output);else{await reader.file(output,entry.size);await fsp.chmod(output,entry.mode)}
  }
  if(first)fail("copy archive is empty");await reader.end();for(const directory of directories.reverse())await fsp.chmod(directory.path,directory.mode);
  if(await exists(target)){if(!overwrite)fail("copy destination already exists; use --overwrite");await fsp.rename(target,backup);backedUp=true}
  try{await fsp.rename(stage,target)}catch(promotionError){if(backedUp){try{await fsp.rename(backup,target);backedUp=false}catch(restorationError){throw new AggregateError([promotionError,restorationError],"copy promotion failed; old destination backup retained at '"+backup+"'")}}throw promotionError}
  await fsp.rm(staging,{recursive:true,force:true});if(backedUp){await fsp.rm(backup,{recursive:true,force:true});backedUp=false}
}
async function cleanup(){await fsp.rm(staging,{recursive:true,force:true})}
async function main(){
  if(!direction||!operand||marker!=="dim-workspace-copy"||role!=="helper"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token))fail("invalid workspace copy invocation");
  if(direction==="send"){
    const info=await fsp.lstat(target);if(info.isDirectory()&&!recursive)fail("workspace copy source is a directory; use --recursive");if(info.isSymbolicLink())fail("a copied symlink must be contained in a recursive directory source");
    await write(magic);await pack(target,".",await fsp.realpath(target));await write(Buffer.alloc(4));return;
  }
  if(direction!=="receive")fail("invalid workspace copy direction");await receive();
}
main().catch(async error=>{await cleanup();process.stderr.write((error instanceof Error?error.message:String(error))+"\n");process.exitCode=2});
`;

export const workspaceCopyCleanup = String.raw`
const fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path");
const [operand,marker,role,token]=process.argv.slice(1);
const fail=(message)=>{throw new Error(message)};
if(!operand||marker!=="dim-workspace-copy"||role!=="cleanup"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token))fail("invalid workspace copy cleanup invocation");
const target=path.resolve(operand),parent=path.dirname(target),staging=path.join(parent,".dim-copy-"+token),stage=path.join(staging,"payload"),backup=path.join(parent,".dim-copy-backup-"+token);
const exists=async(file)=>{try{await fsp.lstat(file);return true}catch(error){if(error&&error.code==="ENOENT")return false;throw error}};
const matches=(pid)=>{try{const args=fs.readFileSync("/proc/"+pid+"/cmdline","utf8").split("\0").filter(Boolean);return args.at(-3)===marker&&args.at(-2)==="helper"&&args.at(-1)===token}catch{return false}};
const signal=(pid,name)=>{try{process.kill(Number(pid),name)}catch(error){if(error.code!=="ESRCH")throw error}};
async function stop(){
  const owned=fs.readdirSync("/proc").filter(pid=>/^\d+$/.test(pid)&&matches(pid));
  for(const pid of owned)signal(pid,"SIGTERM");
  const graceful=Date.now()+750;while(owned.some(matches)&&Date.now()<graceful)await new Promise(resolve=>setTimeout(resolve,10));
  for(const pid of owned.filter(matches))signal(pid,"SIGKILL");
  const killed=Date.now()+500;while(owned.some(matches)&&Date.now()<killed)await new Promise(resolve=>setTimeout(resolve,10));
  if(owned.some(matches))fail("owned workspace copy helper did not exit");
}
async function recover(){
  const hasBackup=await exists(backup),hasStage=await exists(stage),hasTarget=await exists(target);
  if(hasBackup){
    if(!hasTarget)await fsp.rename(backup,target);
    else if(!hasStage){await fsp.mkdir(staging,{recursive:true,mode:448});await fsp.rename(target,stage);await fsp.rename(backup,target)}
    else fail("workspace copy cancellation found a conflicting destination; old data remains in "+backup);
  }
  await fsp.rm(staging,{recursive:true,force:true});
  if(await exists(backup))fail("workspace copy cancellation could not restore old data from "+backup);
}
(async()=>{await stop();await recover()})().catch(error=>{process.stderr.write(error.message+"\n");process.exitCode=1});
`;
