import { Readable, Writable } from "node:stream";
import { deployGuestIntegration, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
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
  readonly workspace: WorkspaceRecord; readonly context: WorkspaceHostPluginContext; readonly previous: string | undefined; readonly token: string;
}): Promise<void> {
  const { workspace, context, previous, token } = input;
  const current = await snapshotRouterConnection(workspace, { ...context, signal: AbortSignal.timeout(10_000) });
  if (current === previous) return;
  if (current === undefined) {
    if (previous === undefined) return;
    throw new Error("workspace LLM connection disappeared during rollback; refusing to overwrite user changes");
  }
  const value: unknown = JSON.parse(current);
  if (!value || typeof value !== "object" || !("token" in value) || value.token !== token) throw new Error("workspace LLM connection changed during rollback; refusing to overwrite user changes");
  if (previous !== undefined) {
    await deployGuestIntegration({ service: context.service, workspace, signal: AbortSignal.timeout(10_000) }, {
      name: "llm-router-rollback", files: [{ path: ".config/dim/llm-router.json", contents: previous, mode: 0o600 }],
    });
    return;
  }
  const code = await context.service.exec(workspace.name, ["node", "-e", remove, workspace.id], {
    workspaceId: workspace.id, signal: AbortSignal.timeout(10_000), stdin: Readable.from([token]),
    stdout: new Writable({ write(_chunk, _encoding, done) { done(); } }), stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
  });
  if (code !== 0) throw new Error("cannot roll back the provisional workspace LLM connection");
}

const snapshot = String.raw`
const fs=require('node:fs'),path=require('node:path');
const file=path.join(process.env.HOME,'.config/dim/llm-router.json');
let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK)}catch(error){if(error.code==='ENOENT')process.exit(0);throw error}
try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&511)!==384||s.size>65536)throw Error('unsafe connection');
const bytes=fs.readFileSync(fd),value=JSON.parse(bytes);if(value.workspaceId!==process.argv[1]||typeof value.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value.token))throw Error('invalid scoped connection');process.stdout.write(bytes)}finally{fs.closeSync(fd)}
`;
const remove = String.raw`
const fs=require('node:fs'),path=require('node:path');let token='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{token+=chunk;if(token.length>43)process.exit(2)});
process.stdin.on('end',()=>{const file=path.join(process.env.HOME,'.config/dim/llm-router.json');
let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK)}catch(error){if(error.code==='ENOENT')return;throw error}
let value;try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||s.size>65536)throw Error('unsafe connection');value=JSON.parse(fs.readFileSync(fd,'utf8'))}finally{fs.closeSync(fd)}
if(value.workspaceId!==process.argv[1]||value.token!==token)throw Error('connection changed during rollback');fs.unlinkSync(file)});
`;
