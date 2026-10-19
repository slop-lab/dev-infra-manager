import type { WorkspaceHostPlugin } from "@slop-lab/dim-core/workspace";
import { hostMirrorProvider, workspaceCacheEndpoints } from "./provider.js";
import { attachWorkspaceMirrors } from "./attachment.js";
export { hostMirrorProvider } from "./provider.js";

export const plugin = {
  name: "@slop-lab/dim-plugin-host-mirrors",
  apiVersion: 4 as const,
  register(host: { registerExtension(kind: string, name: string, extension: object): void }) {
    host.registerExtension("dim.host-mirror-provider", "host", hostMirrorProvider);
  }
};

export default plugin;

export const hostPlugin: WorkspaceHostPlugin = {
  name: "@slop-lab/dim-plugin-host-mirrors",
  commands: [{ name: "mirrors", description: "Reconcile optional host Docker and APT caches" }],
  async run(args, context) {
    if (args.length !== 2 || args[1] !== "ensure") throw new Error("usage: dim mirrors ensure");
    await hostMirrorProvider.ensure(context.runner);
    console.log("Host Docker and APT mirror services are ready.");
  },
  async workspaceReady(workspace, context) {
    if (!workspace.initialized || workspace.phase !== "running") return;
    await hostMirrorProvider.ensure(context.runner);
    await attachWorkspaceMirrors(workspace, context, await workspaceCacheEndpoints(context.runner));
  }
};
