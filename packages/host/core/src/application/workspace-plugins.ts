import { UserError } from "../errors.js";
import type { WorkspaceRecord } from "../workspace/models.js";
import type { AgentHostContext } from "./workspace-agent.js";
import { loadHostPlugins, hostPluginExtensions } from "./host-plugins.js";
import { workspaceAgentGeneration } from "./workspace-agent-state.js";
import { deployWorkspaceDiscovery } from "./workspace-discovery.js";
import { workspacePreparationFailurePrefix } from "./workspace-readiness.js";

export async function prepareWorkspacePlugins(record: WorkspaceRecord, context: AgentHostContext): Promise<void> {
  const installed = await loadHostPlugins(), pluginContext = { ...context, extensions: hostPluginExtensions(installed) };
  for (const plugin of installed) await plugin.workspaceReady?.(record, pluginContext);
  const current = await context.store.read(record.name);
  if (current.id !== record.id || current.phase !== "running") throw new UserError("workspace changed during plugin preparation");
  const { error, ...recovered } = current;
  await deployWorkspaceDiscovery({ workspace: error?.startsWith(workspacePreparationFailurePrefix) ? recovered : current,
    plugins: installed, context: { ...pluginContext, generation: await workspaceAgentGeneration() } });
}
