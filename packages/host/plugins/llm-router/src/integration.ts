import { Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { deployGuestIntegration, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import { type WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";

export async function deployRouterHelpers(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<void> {
  const adapterPath = await routerAdapterPath(workspace, context);
  await deployGuestIntegration({ service: context.service, workspace, signal: context.signal }, {
    name: "llm-router-assets", files: [
      { path: adapterPath, contents: await readFile(new URL("./opencode.js", import.meta.url)), mode: 0o600 },
      { path: ".config/dim/opencode-launch.js", contents: await readFile(new URL("./opencode-launch.js", import.meta.url)), mode: 0o600 }
    ]
  });
}
const adapterLocationProbe = String.raw`
const path=require("node:path"),os=require("node:os");
try{const home=os.homedir(),config=process.env.XDG_CONFIG_HOME||path.join(home,".config");
 if(!path.isAbsolute(config))throw Error("XDG_CONFIG_HOME must be absolute");
 const file=path.relative(home,path.join(config,"opencode/plugins/dim-llm-router.js"));
 if(file===".."||file.startsWith(".."+path.sep)||path.isAbsolute(file)||file.length>4096||/[\x00-\x1f\x7f]/.test(file))throw Error("unsupported config location");
 process.stdout.write(JSON.stringify({path:file}));
}catch{process.exitCode=2}`;
async function routerAdapterPath(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<string> {
  const chunks: Buffer[] = []; let bytes = 0, overflow = false;
  const stdout = new Writable({ write(chunk: Buffer, _encoding, done) { bytes += chunk.length; if (bytes > 8192) overflow = true; else chunks.push(Buffer.from(chunk)); done(); } });
  const result = await context.service.exec(workspace.name, ["node", "-e", adapterLocationProbe], { workspaceId: workspace.id, signal: context.signal, stdout });
  if (result !== 0 || overflow) throw new Error("LLM integration requires XDG_CONFIG_HOME to select a directory inside workspace HOME; attachment was not published");
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string") throw new Error("invalid workspace OpenCode configuration location");
  // The shared writer independently validates all relative paths and rejects
  // symlinks, so an untrusted guest response cannot select a host path.
  return value.path;
}
const connectionProbe = String.raw`
const fs=require("node:fs"),path=require("node:path");
(async()=>{
 let file;
 try{file=fs.openSync(path.join(process.env.HOME,".config/dim/llm-router.json"),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK)}
 catch(error){if(error.code==="ENOENT"){process.exitCode=3;return}throw error}
 let connection;try{const info=fs.fstatSync(file);if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid()||(info.mode&0o777)!==0o600||info.size>65536)throw Error("unsafe LLM connection");connection=JSON.parse(fs.readFileSync(file,"utf8"))}finally{fs.closeSync(file)}
 if(connection.workspaceId!==process.argv[1]||typeof connection.token!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(connection.token)){process.exitCode=3;return}
 if(process.argv[2]==="live"){try{
const home=process.env.HOME,config=process.env.XDG_CONFIG_HOME||path.join(home,".config"),relative=path.relative(home,config);
if(!path.isAbsolute(config)||relative===".."||relative.startsWith(".."+path.sep)||path.isAbsolute(relative))throw Error("unsupported config location");
const adapter=fs.openSync(path.join(config,"opencode/plugins/dim-llm-router.js"),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
try{const info=fs.fstatSync(adapter);if(!info.isFile()||info.uid!==process.getuid()||info.nlink!==1||!info.size)throw Error("adapter unavailable")}finally{fs.closeSync(adapter)}
const url=new URL(connection.endpoint);if(url.origin!==connection.endpoint||!["http:","https:"].includes(url.protocol))throw Error("invalid endpoint");const response=await fetch(connection.endpoint+"/v1/models",{redirect:"error",signal:AbortSignal.timeout(2000),headers:{authorization:"Bearer "+connection.token}});await response.body?.cancel();if(response.status!==200)process.exitCode=3}catch{process.exitCode=3}}
})().catch(()=>{process.exitCode=3});`;
export async function hasRouterConnection(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext, live = false): Promise<boolean> {
  if (!workspace.initialized || workspace.phase !== "running") return false;
  const result = await context.service.exec(workspace.name, ["node", "-e", connectionProbe, workspace.id, live ? "live" : "local"], {
    workspaceId: workspace.id, signal: context.signal
  });
  return result === 0;
}
