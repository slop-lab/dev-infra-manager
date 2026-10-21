import { readFile } from "node:fs/promises";
import { deployGuestIntegration, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import { type WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";

export async function deployToolHelpers(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<void> {
  if (!workspace.initialized || workspace.phase !== "running") return;
  const setup = await readFile(new URL("./assets/tool-setup.bash", import.meta.url));
  const agent = await readFile(new URL("./assets/agent.mjs", import.meta.url));
  const server = await readFile(new URL("./assets/opencode-server.bash", import.meta.url));
  await deployGuestIntegration({ service: context.service, workspace, signal: context.signal }, {
    name: "agent-tools", files: [
      { path: ".local/share/dim-agent-tools/tool-setup.bash", contents: setup, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/agent.mjs", contents: agent, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/opencode-server.bash", contents: server, mode: 0o700 },
      { path: ".local/bin/dim-agent", contents: agent, mode: 0o700 },
      { path: ".local/bin/dim-opencode-server", contents: server, mode: 0o700 },
      { path: ".local/bin/dim-tools-setup", contents: '#!/bin/sh\nexec bash "$HOME/.local/share/dim-agent-tools/tool-setup.bash" "$@"\n', mode: 0o700 }
    ]
  });
}
export async function inspectTools(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext) {
  if (!workspace.initialized || workspace.phase !== "running") return { state: "unconfigured" as const, message: "Start the workspace to prepare helper commands" };
  const result = await context.service.exec(workspace.name, ["node", "-e", String.raw`
const fs=require("node:fs"),path=require("node:path");
const home=fs.realpathSync(process.env.HOME),versions={opencode:"1.18.31",codex:"0.156.1"};
const ready=Object.entries(versions).some(([tool,version])=>{let fd;try{
 fd=fs.openSync(path.join(home,".local/state/dim-tools",tool+".json"),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 const info=fs.fstatSync(fd);if(!info.isFile()||info.uid!==process.getuid()||(info.mode&0o777)!==0o600||info.size>16384)return false;
 const manifest=JSON.parse(fs.readFileSync(fd,"utf8")),executable=path.join(home,".local/bin",tool);
 if(manifest.tool!==tool||manifest.version!==version||manifest.executable!==executable)return false;
 const target=fs.realpathSync(executable),relative=path.relative(home,target);
 if(relative===".."||relative.startsWith(".."+path.sep)||path.isAbsolute(relative)||!fs.statSync(target).isFile())return false;
 fs.accessSync(target,fs.constants.X_OK);return true;
}catch{return false}finally{if(fd!==undefined)fs.closeSync(fd)}});process.exitCode=ready?0:3;`], { workspaceId: workspace.id, signal: context.signal });
  return result === 0 ? { state: "ready" as const, message: "At least one pinned tool is configured; use dim-agent opencode or dim-agent codex for the installed tool" }
    : { state: "unconfigured" as const, message: "Helpers are available. Run dim-tools-setup opencode|codex in the workspace, or dim tools setup WORKSPACE TOOL on the host; no npm tools were installed automatically" };
}
