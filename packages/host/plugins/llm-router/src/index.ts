import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";
import { deployRouterHelpers, hasRouterConnection, repairRouterConnectionEndpoint } from "./integration.js";
import { runLlmCommand } from "./cli.js";
import { runLlmRouterCommand } from "./operator/commands.js";
import { workspaceRouterServices } from "./workspaceService.js";
export const hostPlugin: WorkspaceHostPlugin = { name: "host-llm-router", commands: [
  { name: "llm", description: "Connect a host gateway and attach workspaces to control-plane LLM routing" },
  { name: "llm-router", description: "Inspect and manage an LLM router through a private operator connection" }
 ],
  async run(args, context) {
    if (args[0] === "llm-router") await runLlmRouterCommand(args, context.signal);
    else await runLlmCommand(args, context);
  },
  async workspaceReady(workspace, context) {
    if (await hasRouterConnection(workspace, context)) {
      if (!await workspaceRouterServices.resolve("llm-router", workspace, context)) throw new Error(`workspace '${workspace.name}' retains an LLM credential but has no pinned host gateway selection; run dim llm recover ${workspace.name} --config ORIGINAL_GATEWAY_CONFIG on the selected host. Existing project, route and credentials are preserved; no gateway is selected automatically`);
      await deployRouterHelpers(workspace, context);
      await repairRouterConnectionEndpoint(workspace, context);
    }
  },
  workspaceServices: workspaceRouterServices,
  guest: {
    description: "Project-scoped LLM access through this host gateway, with private control-plane credentials kept outside the workspace",
    commands: [{ name: "opencode", description: "Attached OpenCode routes through the configured project; explicit host-side dim llm attach is required first" }],
    async inspect(workspace, context) {
      if (await hasRouterConnection(workspace, context) && !await workspaceRouterServices.resolve("llm-router", workspace, context)) {
        return { state: "unconfigured", message: `Retained LLM credential needs its original gateway selection: dim llm recover ${workspace.name} --config ORIGINAL_GATEWAY_CONFIG on the selected host; credentials and route are retained` };
      }
      return await hasRouterConnection(workspace, context, true)
        ? { state: "ready", message: "Attached project gateway is reachable; no provider login or credential rotation is performed by preparation" }
        : { state: "unconfigured", message: "Run dim llm attach WORKSPACE --config CONFIG --project PROJECT on the host, or start its configured gateway" };
    }
  }
};
export { createHostGateway } from "./gateway.js";
export { parseHostConfig, loadHostConfig } from "./config.js";
