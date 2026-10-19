import { atomicWrite } from "@slop-lab/dim-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceHostPlugin } from "@slop-lab/dim-core/workspace";
import { hostMirrorProvider, readCacheEndpoints, mirrorStateRoot, parseCacheCatalog } from "./provider.js";
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
  name: "host-mirrors",
  commands: [{ name: "mirrors", description: "Connect workspaces and CI to package caches" }],
  async run(args, context) {
    if (args.length === 3 && args[1] === "configure") {
      const endpoints = parseCacheCatalog(JSON.parse(await readFile(args[2]!, "utf8")));
      await atomicWrite(join(mirrorStateRoot(), "config.json"), { schemaVersion: 1, endpoints });
      console.log("Cache endpoints saved. Run dim mirrors ensure; workspaces refresh on their next lifecycle/exec operation."); return;
    }
    if (args.length !== 2 || args[1] !== "ensure") throw new Error("usage: dim mirrors ensure | dim mirrors configure FILE");
    await hostMirrorProvider.ensure(context.runner);
    console.log("Docker, npm, PyPI and APT cache connections are configured.");
  },
  async workspaceReady(workspace, context) {
    if (!workspace.initialized || workspace.phase !== "running") return;
    const endpoints = await readCacheEndpoints();
    await attachWorkspaceMirrors(workspace, context, { endpoints });
  }
};
