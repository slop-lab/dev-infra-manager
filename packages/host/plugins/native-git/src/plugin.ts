import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/workspace";
import { managedStateRoot } from "@slop-lab/dim-host-core/controller";
export const hostPlugin: WorkspaceHostPlugin = {
  name: "native-git",
  source: {
    schemes: ["dim"],
    async create(input, context) {
      const { createManagedWorkspace } = await import("./nativeWorkspaceHost.js");
      return createManagedWorkspace(input, context);
    },
    async ensure(workspace, context) {
      const { ensureManagedWorkspace } = await import("./nativeWorkspaceHost.js");
      await ensureManagedWorkspace(workspace, context);
    }
  },
  async workspaceMetadata(workspace, context) {
    if (!workspace.source.url.startsWith("dim://")) return;
    const { nativeWorkspaceMetadata } = await import("./nativeWorkspaceMetadata.js");
    return nativeWorkspaceMetadata(workspace, managedStateRoot(process.env), context.stateRoot);
  },
  commands: [{ name: "project", description: "Register Native Projects and their independent reviewed repositories" }],
  async run(args) { const { runNativeGitCli } = await import("./cli/index.js"); await runNativeGitCli(args); }
};
