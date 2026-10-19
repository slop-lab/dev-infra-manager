import { Readable, Writable } from "node:stream";
import { UserError } from "../errors.js";
import type { WorkspaceRecord } from "./models.js";
import type { WorkspaceExecOptions, WorkspaceService } from "./service.js";

export interface GuestIntegrationContext {
  readonly service: Pick<WorkspaceService, "exec">;
  readonly workspace: WorkspaceRecord;
  readonly signal: AbortSignal;
}
export interface GuestIntegrationTarget { readonly container: string; readonly user?: string }
export interface GuestIntegration {
  readonly name: string;
  readonly files: readonly { readonly path: string; readonly contents: string | Uint8Array; readonly mode?: 0o600 | 0o700 }[];
  readonly target?: GuestIntegrationTarget;
}
const maximumFiles = 64, maximumBytes = 4 * 1024 * 1024;

/** Explicit targets always refer to the workspace's Docker, never the host runtime. */
export async function execGuestIntegrationTarget(context: GuestIntegrationContext, target: GuestIntegrationTarget | undefined,
  command: readonly string[], options: Pick<WorkspaceExecOptions, "stdin" | "stdout" | "stderr"> = {}): Promise<number> {
  context.signal.throwIfAborted();
  let argv = [...command];
  if (target !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(target.container)
      || target.user !== undefined && !/^(?:[a-zA-Z_][a-zA-Z0-9_-]{0,63}|[0-9]{1,10})(?::(?:[a-zA-Z_][a-zA-Z0-9_-]{0,63}|[0-9]{1,10}))?$/.test(target.user)) {
      throw new UserError("nested integration target must select a container and optional user without options or paths");
    }
    let output = "", overflow = false;
    const stdout = new Writable({ write(chunk: Buffer, _encoding, done) {
      if (output.length + chunk.length > 256) overflow = true;
      else output += chunk.toString("utf8");
      done();
    } });
    const inspected = await context.service.exec(context.workspace.name, ["docker", "container", "inspect", "--format", "{{.Id}}", "--", target.container], {
      workspaceId: context.workspace.id, signal: context.signal, stdout, stderr: new Writable({ write(_chunk, _encoding, done) { done(); } })
    });
    if (inspected !== 0 || overflow || !/^[a-f0-9]{64}\n?$/.test(output)) throw new UserError("nested integration container could not be identified in this workspace");
    argv = ["docker", "exec", "--interactive", ...(target.user === undefined ? [] : ["--user", target.user]), "--", output.trim(), ...command];
  }
  return context.service.exec(context.workspace.name, argv, { ...options, workspaceId: context.workspace.id, signal: context.signal });
}

/** Publish only explicitly supplied guest data. No host path, secret or socket is mounted. */
export async function deployGuestIntegration(context: GuestIntegrationContext, integration: GuestIntegration): Promise<void> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(integration.name) || integration.files.length > maximumFiles) throw new UserError("invalid guest integration name or file count");
  let size = 0;
  const paths = new Set<string>();
  const files = integration.files.map((file) => {
    const path = file.path;
    if (!path || path.length > 4096 || /[\\\x00-\x1f\x7f]/.test(path)
      || (path.split("/").length > 64 || path.split("/").some((part) => !part || part === "." || part === "..")) || paths.has(path)) throw new UserError("integration files must have distinct HOME-relative paths without traversal");
    const mode = file.mode ?? 0o600;
    if (mode !== 0o600 && mode !== 0o700) throw new UserError("integration files must use private mode 0600 or 0700");
    const bytes = typeof file.contents === "string" ? Buffer.from(file.contents) : Buffer.from(file.contents);
    size += bytes.length;
    if (size > maximumBytes) throw new UserError("guest integration exceeds the 4 MiB file budget");
    paths.add(path); return { path, mode, contents: bytes.toString("base64") };
  });
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      if (paths.has(parts.slice(0, index).join("/"))) throw new UserError("integration file paths cannot also be parent directories");
    }
  }
  const code = await execGuestIntegrationTarget(context, integration.target, ["node", "--input-type=commonjs", "-e", writer], {
    stdin: Readable.from([JSON.stringify({ name: integration.name, files })]),
    stdout: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    stderr: new Writable({ write(_chunk, _encoding, done) { done(); } })
  });
  if (code !== 0) throw new UserError(`cannot safely prepare guest integration '${integration.name}'; target requires Node.js and a writable user-owned HOME (exit ${code})`);
}

// Directory descriptors anchor every lookup inside the selected user's HOME.
// A guest changing an ancestor path cannot redirect publication through a symlink.
const writer = String.raw`
const fs=require('node:fs'),os=require('node:os'),{randomUUID}=require('node:crypto'),C=fs.constants;
let input='',size=0;
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{size+=Buffer.byteLength(chunk);if(size>6*1024*1024){process.stderr.write('integration input exceeds its bound\n');process.exit(2)}input+=chunk});
process.stdin.on('end',()=>{
 const descriptors=[];
 try {
  const payload=JSON.parse(input),uid=process.getuid();
  if(!Array.isArray(payload.files)||payload.files.length>64)throw Error('invalid payload');
  const homePath=os.homedir();if(fs.realpathSync(homePath)!==homePath)throw Error('unsafe home');
  const home=fs.openSync(homePath,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  descriptors.push(home);checkDirectory(home);
  for(const file of payload.files){
   const parents=[];try{
   const parts=file.path.split('/');let parent=home;
   for(const part of parts.slice(0,-1)){
    const path='/proc/self/fd/'+parent+'/'+part;
    try{fs.mkdirSync(path,{mode:0o700})}catch(error){if(error.code!=='EEXIST')throw error}
    const child=fs.openSync(path,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
    parents.push(child);checkDirectory(child);parent=child;
   }
   const name=parts[parts.length-1],path='/proc/self/fd/'+parent+'/'+name,bytes=Buffer.from(file.contents,'base64');
   let unchanged=false;
   for(let attempt=0;attempt<5;attempt++){
    let existing;
    try{
     existing=fs.openSync(path,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
     const stat=fs.fstatSync(existing);checkFile(stat,true);
     // A concurrent publisher may replace an inode after open. Reopen the
     // current path without reading/trusting the unlinked inode's contents.
     if(stat.nlink===0){if(attempt===4)throw Error('unstable file');continue}
     unchanged=stat.size<=4*1024*1024&&stat.mode%0o1000===file.mode&&fs.readFileSync(existing).equals(bytes);
     break;
    }catch(error){if(error.code!=='ENOENT')throw error;break}finally{if(existing!==undefined)fs.closeSync(existing)}
   }
   if(unchanged)continue;
   const temporary='/proc/self/fd/'+parent+'/.dim-integration-'+randomUUID();let staging;
   try{
    staging=fs.openSync(temporary,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,file.mode);
    fs.writeFileSync(staging,bytes);fs.fchmodSync(staging,file.mode);fs.fsyncSync(staging);fs.closeSync(staging);staging=undefined;
    // Recheck an existing destination immediately before replacing it; rename
    // itself never follows a destination symlink.
    try{checkFile(fs.lstatSync(path))}catch(error){if(error.code!=='ENOENT')throw error}
    fs.renameSync(temporary,path);fs.fsyncSync(parent);
   }finally{if(staging!==undefined)fs.closeSync(staging);try{fs.unlinkSync(temporary)}catch(error){if(error.code!=='ENOENT')throw error}}
   }finally{for(const fd of parents.reverse())fs.closeSync(fd)}
  }
  function checkDirectory(fd){const stat=fs.fstatSync(fd);if(!stat.isDirectory()||stat.uid!==uid||(stat.mode&0o022)!==0)throw Error('unsafe directory')}
  function checkFile(stat,removed=false){if(!stat.isFile()||stat.uid!==uid||(stat.nlink!==1&&!(removed&&stat.nlink===0)))throw Error('unsafe file')}
 }catch{process.stderr.write('integration could not safely publish files\n');process.exitCode=2}
 finally{for(const fd of descriptors.reverse())fs.closeSync(fd)}
});
`;
