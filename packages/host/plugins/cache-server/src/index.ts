import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/plugin-api";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureLocalCaches } from "./provider.js";
export const hostPlugin: WorkspaceHostPlugin = {
  name: "cache-server",
  commands: [{ name: "cache-server", description: "Provision selected host package caches and publish their URLs" }],
  async run(args, context) {
    if (!["ensure", "endpoints"].includes(args[1] ?? "") || args[1] === "endpoints" && args.length !== 2) throw new Error("usage: dim cache-server ensure [docker npm pypi apt...] | dim cache-server endpoints");
    if (args[1] === "ensure") await ensureLocalCaches(context.runner, context.stateRoot, args.length > 2 ? args.slice(2) : undefined);
    console.log(JSON.stringify(JSON.parse(await readFile(join(context.stateRoot, "services/package-caches.json"), "utf8")), null, 2));
  }
};
