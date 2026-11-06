import { Readable, Writable } from "node:stream";
import type { WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";

export async function snapshotRouterConnection(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<string | undefined> {
  const chunks: Buffer[] = []; let size = 0;
  const stdout = new Writable({ write(chunk: Buffer, _encoding, done) { size += chunk.length; if (size <= 65536) chunks.push(Buffer.from(chunk)); done(); } });
  const code = await context.service.exec(workspace.name, ["node", "-e", snapshot, workspace.id], {
    workspaceId: workspace.id, signal: context.signal, stdout,
    stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
  });
  if (code !== 0 || size > 65536) throw new Error("cannot snapshot the private workspace LLM connection");
  return size === 0 ? undefined : Buffer.concat(chunks).toString("utf8");
}

export async function restoreRouterConnection(input: {
  readonly workspace: WorkspaceRecord; readonly context: WorkspaceHostPluginContext; readonly previous: string | undefined; readonly expected: string;
}): Promise<void> {
  const { workspace, context, previous, expected } = input;
  const code = await context.service.exec(workspace.name, ["node", "-e", restore, workspace.id], {
    workspaceId: workspace.id, signal: AbortSignal.timeout(10_000), stdin: Readable.from([JSON.stringify({ previous, expected })]),
    stdout: new Writable({ write(_chunk, _encoding, done) { done(); } }), stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
  });
  if (code !== 0) throw new Error("cannot roll back the workspace LLM connection; current state must match the expected publication");
}

const snapshot = String.raw`
const fs=require('node:fs'),path=require('node:path');
const file=path.join(process.env.HOME,'.config/dim/llm-router.json');
let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK)}catch(error){if(error.code==='ENOENT')process.exit(0);throw error}
try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&511)!==384||s.size>65536)throw Error('unsafe connection');
const bytes=fs.readFileSync(fd),value=JSON.parse(bytes);if(value.workspaceId!==process.argv[1]||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token))throw Error('invalid scoped connection');process.stdout.write(bytes)}finally{fs.closeSync(fd)}
`;
const restore = String.raw`
const fs=require('node:fs'),os=require('node:os'),C=fs.constants;let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk;if(Buffer.byteLength(input)>4*65536+1024)process.exit(2)});
process.stdin.on('end',()=>{
 const {previous,expected}=JSON.parse(input),descriptors=[];
 try{
  const home=os.homedir();if(fs.realpathSync(home)!==home)throw Error('unsafe home');
  let parent=fs.openSync(home,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);descriptors.push(parent);checkDirectory(parent);
  for(const part of ['.config','dim']){
   try{parent=fs.openSync('/proc/self/fd/'+parent+'/'+part,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW)}catch(error){if(error.code==='ENOENT'&&previous===undefined)return;throw error}
   descriptors.push(parent);checkDirectory(parent);
  }
  const file='/proc/self/fd/'+parent+'/llm-router.json';
  function checkDirectory(fd){const stat=fs.fstatSync(fd);if(!stat.isDirectory()||stat.uid!==process.getuid()||(stat.mode&0o022)!==0)throw Error('unsafe directory')}
 function validate(bytes){const value=JSON.parse(bytes);if(value.workspaceId!==process.argv[1]||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token))throw Error('invalid scoped connection')}
 function read(){let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK)}catch(error){if(error.code==='ENOENT')return;throw error}
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.uid!==process.getuid()||stat.nlink!==1||(stat.mode&511)!==384||stat.size>65536)throw Error('unsafe connection');
   const buffer=Buffer.alloc(65537),length=fs.readSync(fd,buffer,0,buffer.length,0);if(length>65536)throw Error('connection too large');
   const bytes=buffer.subarray(0,length);validate(bytes);return {stat,bytes};
  }finally{fs.closeSync(fd)}}
 if(typeof expected!=='string'||(previous!==undefined&&typeof previous!=='string'))throw Error('invalid rollback state');
 validate(expected);if(previous!==undefined)validate(previous);
 const current=read();
 if(!current){if(previous===undefined)return;throw Error('connection disappeared during rollback')}
 if(previous!==undefined&&current.bytes.equals(Buffer.from(previous)))return;
 if(!current.bytes.equals(Buffer.from(expected)))throw Error('connection changed during rollback');
  if(previous===undefined){fs.unlinkSync(file);fs.fsyncSync(parent);return}
 const temporary=file+'.'+require('node:crypto').randomUUID(),fd=fs.openSync(temporary,'wx',384);
  try{fs.writeFileSync(fd,previous);fs.fsyncSync(fd);const latest=read();
  if(!latest||latest.stat.dev!==current.stat.dev||latest.stat.ino!==current.stat.ino||!latest.bytes.equals(current.bytes))throw Error('connection changed before rollback publication');
   fs.renameSync(temporary,file);fs.fsyncSync(parent);
  }finally{fs.closeSync(fd);try{fs.unlinkSync(temporary)}catch(error){if(error.code!=='ENOENT')throw error}}
 }finally{for(const fd of descriptors.reverse())fs.closeSync(fd)}
});
`;
