import { readFile } from "node:fs/promises";
import { toolStatusScript } from "./toolStatus.js";
import { deployGuestIntegration, type WorkspaceRecord } from "@slop-lab/dim-host-core/workspace";
import { type WorkspaceHostPluginContext } from "@slop-lab/dim-host-core/plugin-api";

export async function deployToolHelpers(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext): Promise<void> {
  if (!workspace.initialized || workspace.phase !== "running") return;
  const availability = await readFile(new URL("./assets/omo-model-availability.mjs", import.meta.url));
  const setup = await readFile(new URL("./assets/tool-setup.bash", import.meta.url));
  const agent = await readFile(new URL("./assets/agent.mjs", import.meta.url));
  const runtime = await readFile(new URL("./assets/opencode-runtime.bash", import.meta.url));
  const server = await readFile(new URL("./assets/opencode-server.bash", import.meta.url));
  await deployGuestIntegration({ service: context.service, workspace, signal: context.signal }, {
    name: "agent-tools", files: [
      { path: ".local/share/dim-agent-tools/omo-model-availability.mjs", contents: availability, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/tool-setup.bash", contents: setup, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/agent.mjs", contents: agent, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/opencode-runtime.bash", contents: runtime, mode: 0o700 },
      { path: ".local/share/dim-agent-tools/opencode-server.bash", contents: server, mode: 0o700 },
      { path: ".local/bin/dim-agent", contents: agent, mode: 0o700 },
      { path: ".local/bin/dim-opencode-server", contents: server, mode: 0o700 },
      { path: ".local/bin/dim-tools-setup", contents: '#!/bin/sh\nexec bash "$HOME/.local/share/dim-agent-tools/tool-setup.bash" "$@"\n', mode: 0o700 }
    ]
  });
}
export async function inspectTools(workspace: WorkspaceRecord, context: WorkspaceHostPluginContext) {
  if (!workspace.initialized || workspace.phase !== "running") return { state: "unconfigured" as const, message: "Start the workspace to prepare helper commands" };
  const result = await context.service.exec(workspace.name, ["node", "-e", toolStatusScript, "--", "--inspect"], { workspaceId: workspace.id, signal: context.signal });
  return result === 0 ? { state: "ready" as const, message: "At least one pinned tool is configured; use dim-agent opencode or dim-agent codex for the installed tool" }
    : { state: "unconfigured" as const, message: "Helpers are available. Run dim-tools-setup opencode|codex in the workspace, or dim tools setup WORKSPACE TOOL on the host; no npm tools were installed automatically" };
}
