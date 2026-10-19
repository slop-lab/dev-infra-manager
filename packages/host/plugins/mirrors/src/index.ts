import { atomicWrite } from "@slop-lab/dim-host-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/workspace";
import { hostMirrorProvider, findCacheEndpoints, mirrorStateRoot, parseCacheCatalog } from "./provider.js";
import { attachWorkspaceMirrors } from "./attachment.js";
export { hostMirrorProvider } from "./provider.js";

export const plugin = {
  name: "@slop-lab/dim-host-plugin-mirrors",
  apiVersion: 4 as const,
  register(host: { registerExtension(kind: string, name: string, extension: object): void }) {
    host.registerExtension("dim.host-mirror-provider", "host", hostMirrorProvider);
  }
};

export default plugin;

export const hostPlugin: WorkspaceHostPlugin = {
  name: "host-mirrors",
  async executionRouting(context) {
    if (!await findCacheEndpoints()) return;
    return hostMirrorProvider.ensure(context.runner);
  },
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
  guest: {
    description: "Connect workspace and nested-container package managers to operator-configured Docker, npm, PyPI and APT caches; never deploy a server",
    commands: [
      { name: "docker", description: "Use the configured Docker registry cache" },
      { name: "npm", description: "Use the configured npm cache" },
      { name: "pip", description: "Use the configured PyPI cache" },
      { name: "apt", description: "Use the configured APT cache" }
    ],
    async inspect() {
      return await findCacheEndpoints()
        ? { state: "ready", message: "Package-cache connection configuration is available; this status does not probe cache health" }
        : { state: "unconfigured", message: "Run dim mirrors configure FILE, or publish endpoints from an explicitly installed cache server" };
    }
  },
  async workspaceReady(workspace, context) {
    if (!workspace.initialized || workspace.phase !== "running") return;
    const endpoints = await findCacheEndpoints();
    if (!endpoints) return;
    await attachWorkspaceMirrors(workspace, context, { endpoints });
  }
};
