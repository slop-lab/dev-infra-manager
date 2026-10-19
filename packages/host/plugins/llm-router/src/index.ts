import type { WorkspaceHostPlugin } from "@slop-lab/dim-core/workspace";
import { deployRouterHelpers, hasRouterConnection } from "./integration.js";
import { runLlmCommand } from "./cli.js";
export const hostPlugin: WorkspaceHostPlugin = { name: "host-llm-router", commands: [
  { name: "llm", description: "Connect a host gateway and attach workspaces to control-plane LLM routing" }
 ], run: runLlmCommand,
  async workspaceReady(workspace, context) {
    if (await hasRouterConnection(workspace, context)) await deployRouterHelpers(workspace, context);
  },
  guest: {
    description: "Project-scoped LLM access through this host gateway, with private control-plane credentials kept outside the workspace",
    commands: [{ name: "opencode", description: "Attached OpenCode routes through the configured project; explicit host-side dim llm attach is required first" }],
    async inspect(workspace, context) {
      return await hasRouterConnection(workspace, context, true)
        ? { state: "ready", message: "Attached project gateway is reachable; no provider login or credential rotation is performed by preparation" }
        : { state: "unconfigured", message: "Run dim llm attach WORKSPACE --config CONFIG --project PROJECT on the host, or start its configured gateway" };
    }
  }
};
export { createHostGateway } from "./gateway.js";
export { parseHostConfig, loadHostConfig } from "./config.js";
