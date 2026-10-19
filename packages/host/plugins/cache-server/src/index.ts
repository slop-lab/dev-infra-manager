import type { WorkspaceHostPlugin } from "@slop-lab/dim-host-core/workspace";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureLocalCaches } from "./provider.js";
export const hostPlugin: WorkspaceHostPlugin = {
  name: "cache-server",
  commands: [{ name: "cache-server", description: "Install host-owned public package caches and publish their URLs" }],
  async run(args, context) {
    if (args.length !== 2 || !["ensure", "endpoints"].includes(args[1] ?? "")) throw new Error("usage: dim cache-server ensure | dim cache-server endpoints");
    if (args[1] === "ensure") await ensureLocalCaches(context.runner, context.stateRoot);
    console.log(JSON.stringify(JSON.parse(await readFile(join(context.stateRoot, "services/package-caches.json"), "utf8")), null, 2));
  }
};
