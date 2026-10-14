import { requireNativeControlPlaneConnection } from "./lifecycleOptions.js";
import type { LifecycleOptions, WorkspaceRecord } from "./lifecycleTypes.js";
import { createNativeWorkspace } from "./nativeWorkspaceCreation.js";
import type { RegisteredDimPlugins } from "./plugin.js";
import type { StreamingCommandRunner } from "./types.js";

export async function createWorkspace(
  runner: StreamingCommandRunner,
  options: LifecycleOptions,
  input: {
    project: string;
    name: string;
    profiles: string[];
    requiredCapabilities?: string[];
    recommendedCapabilities?: string[];
    runtimeBackend: WorkspaceRecord["runtimeBackend"];
    cpuCount?: string;
    memory?: string;
    pidsLimit?: string;
    kvm?: boolean;
    gitUserName?: string;
    gitUserEmail?: string;
  },
  plugins: Pick<RegisteredDimPlugins, "workspaceCapabilityProviders"> = {
    workspaceCapabilityProviders: new Map()
  }
): Promise<WorkspaceRecord> {
  requireNativeControlPlaneConnection(options);
  return createNativeWorkspace({ runner, options, request: input, plugins });
}
