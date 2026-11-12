import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { toolStatusScript } from "./toolStatus.js";
import { deployGuestIntegration, type WorkspaceRecord, UserError } from "@slop-lab/dim-host-core/workspace";
import { type WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";

export async function deployToolHelpers(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<void> {
  if (!workspace.initialized || workspace.phase !== "running") return;
  const availability = await readFile(new URL("./assets/omo-model-availability.mjs", import.meta.url));
  const teamMetadata = await readFile(new URL("./assets/opencode-team-metadata.mjs", import.meta.url));
  const setup = await readFile(new URL("./assets/tool-setup.bash", import.meta.url));
  const agent = await readFile(new URL("./assets/agent.mjs", import.meta.url));
  const runtime = await readFile(new URL("./assets/opencode-runtime.bash", import.meta.url));
  const managedService = await readFile(new URL("./assets/opencode-service.bash", import.meta.url));
  const server = await readFile(new URL("./assets/opencode-server.bash", import.meta.url));
  const execution = await Promise.all(["monitor.ts", "monitorMetadata.ts", "monitorClient.ts", "status.ts", "projection.ts", "guest.ts", "cli.ts", "taskContract.ts", "taskJournal.ts", "taskHttp.ts", "taskOwned.ts", "taskGuest.ts", "taskCli.ts", "taskInput.ts"].map(async name => ({
    path: `.local/share/dim-agent-tools/execution/${name}`, contents: await readFile(new URL(`./execution/${name}`, import.meta.url)), mode: 0o700 as const
  })));
  await deployGuestIntegration({ service: context.service, workspace, signal: context.signal }, {
    name: "agent-tools", files: [
      ...execution,
      { path: ".local/share/dim-agent-tools/execution/package.json", contents: '{"type":"module"}\n', mode: 0o600 },
      { path: ".local/share/dim-agent-tools/omo-model-availability.mjs", contents: availability, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/opencode-team-metadata.mjs", contents: teamMetadata, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/tool-setup.bash", contents: setup, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/agent.mjs", contents: agent, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/opencode-runtime.bash", contents: runtime, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/opencode-service.bash", contents: managedService, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/opencode-server.bash", contents: server, mode: 0o700 },
      { path: ".local/bin/dim-agent", contents: agent, mode: 0o700 },
      { path: ".local/bin/dim-opencode-server", contents: server, mode: 0o700 },
      { path: ".local/bin/dim-agent-execution", contents: '#!/bin/sh\nexec node "$HOME/.local/share/dim-agent-tools/execution/cli.ts" "$@"\n', mode: 0o700 },
      { path: ".local/bin/dim-agent-task", contents: '#!/bin/sh\nexec node "$HOME/.local/share/dim-agent-tools/execution/taskCli.ts" "$@"\n', mode: 0o700 },
      { path: ".local/bin/dim-tools-setup", contents: '#!/bin/sh\nexec bash "$HOME/.local/share/dim-agent-tools/tool-setup.bash" "$@"\n', mode: 0o700 }
    ]
  });
}

export async function prepareToolWorkspace(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<void> {
  await deployToolHelpers(workspace, context);
  if (!workspace.initialized || workspace.phase !== "running") return;
  const ignored = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
  const resumed = await context.service.exec(workspace.name, ["bash", "-c", 'exec bash "$HOME/.local/share/dim-agent-tools/opencode-service.bash" __resume'], {
    workspaceId: workspace.id, signal: context.signal, stdout: ignored(), stderr: ignored()
  });
  if (resumed !== 0) throw new UserError("could not resume the registered OpenCode service; inspect its private workspace service log");
}
export async function inspectTools(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext) {
  if (!workspace.initialized || workspace.phase !== "running") return { state: "unconfigured" as const, message: "Start the workspace to prepare helper commands" };
  const result = await context.service.exec(workspace.name, ["node", "-e", toolStatusScript, "--", "--inspect"], { workspaceId: workspace.id, signal: context.signal });
  return result === 0 ? { state: "ready" as const, message: "At least one pinned tool is configured; use dim-agent opencode or dim-agent codex for the installed tool" }
    : { state: "unconfigured" as const, message: "Helpers are available. Run dim-tools-setup opencode|codex in the workspace, or dim tools setup WORKSPACE TOOL on the host; no npm tools were installed automatically" };
}
