import { atomicWrite } from "@slop-lab/dim-host-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";
import { findCacheEndpoints, mirrorStateRoot, parseCacheCatalog, resolveMirrorRouting } from "./provider.js";
import { attachWorkspaceMirrors } from "./attachment.js";
import { adapterModules, loadMirrorAdapters } from "./registry.js";

export const hostPlugin: WorkspaceHostPlugin = {
  name: "host-mirrors",
  async executionRouting(context) {
    const adapters = await loadMirrorAdapters(adapterModules(context.extensions));
    if (!await findCacheEndpoints(adapters)) return;
    return resolveMirrorRouting(adapters);
  },
  commands: [{ name: "mirrors", description: "Connect workspaces and CI to operator-selected package caches" }],
  async run(args, context) {
    const adapters = await loadMirrorAdapters(adapterModules(context.extensions));
    if (args.length === 3 && args[1] === "configure") {
      const endpoints = parseCacheCatalog(JSON.parse(await readFile(args[2]!, "utf8")), adapters);
      await atomicWrite(join(mirrorStateRoot(), "config.json"), { schemaVersion: 1, endpoints });
      console.log("Cache endpoints saved. Workspaces refresh on their next lifecycle or exec operation."); return;
    }
    if (args.length !== 2 || args[1] !== "ensure") throw new Error("usage: dim mirrors ensure | dim mirrors configure FILE");
    const endpoints = await findCacheEndpoints(adapters);
    if (!endpoints) throw new Error("cache URLs are not configured; run dim mirrors configure FILE");
    await resolveMirrorRouting(adapters);
    console.log(`Cache connections configured: ${Object.keys(endpoints).join(", ")}`);
  },
  guest: {
    description: "Connect package clients to the host's selected mirror adapters and cache URLs",
    async inspect(_workspace, context) {
      const adapters = await loadMirrorAdapters(adapterModules(context.extensions));
      const endpoints = await findCacheEndpoints(adapters);
      return endpoints
        ? { state: "ready", message: `Cache connections: ${Object.keys(endpoints).map((kind) => `${kind} (${adapters.get(kind)!.commands.map(({ name }) => name).join(", ")})`).join("; ")}; this status does not probe cache health` }
        : { state: "unconfigured", message: "Run dim mirrors configure FILE, or publish endpoints from a cache server plugin" };
    }
  },
  async workspaceReady(workspace, context) {
    if (!workspace.initialized || workspace.phase !== "running") return;
    const adapters = await loadMirrorAdapters(adapterModules(context.extensions));
    const endpoints = await findCacheEndpoints(adapters);
    if (endpoints) await attachWorkspaceMirrors(workspace, context, { endpoints });
  }
};
