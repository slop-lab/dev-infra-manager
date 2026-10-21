import { z } from "zod";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import type { WebPlugin, WebPluginContext } from "@slop-lab/dim-web/plugin-api";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const workspace = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,47}$/);
const selection = z.object({ controllerId: identifier, workspace, workspaceId: z.string().uuid() }).strict();
const protocol = z.enum(["http", "https", "tcp"]);
const routeId = z.string().uuid();
const routeUrl = z.string().max(4096).refine((value) => {
  try { const url = new URL(value); return ["http:", "https:", "tcp:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password; } catch { return false; }
});
const snapshot = z.object({ workspace, workspaceId: z.string().uuid(),
  ingresses: z.array(z.object({ name: identifier, description: z.string().max(2000), scheme: protocol, driver: z.string().max(128) }).strict()).max(128),
  routes: z.array(z.object({ id: routeId, ingress: identifier, url: routeUrl, permalink: routeUrl.optional(), approval: z.enum(["not-required", "pending", "approved", "revoked"]), port: z.number().int().min(1).max(65535), containers: z.array(z.string().max(128)).max(128), protocol }).strict()).max(1000)
}).strict();
export const operations: readonly Operation[] = [
  { name: "routes.list", description: "Inspect this workspace's ingress routes", access: "read", parseInput: (value) => selection.parse(value), parseOutput: (value) => snapshot.parse(value) },
  { name: "routes.create", description: "Create a workspace route", access: "operator", parseInput: (value) => selection.extend({ ingress: identifier, name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/), port: z.number().int().min(1).max(65535), container: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/).optional(), protocol: protocol.optional() }).parse(value), parseOutput: (value) => snapshot.parse(value) },
  ...(["approve", "revoke"] as const).map((action): Operation => ({ name: `routes.${action}`, description: `${action} a workspace route`, access: "operator", parseInput: (value) => selection.extend({ id: routeId }).parse(value), parseOutput: (value) => snapshot.parse(value) }))
];
async function automatic(context: WebPluginContext) {
  return { operations, async invoke(name: string, value: unknown) {
    const operation = operations.find((entry) => entry.name === name); if (!operation) throw new Error("Unknown external route operation");
    const { controllerId, ...input } = selection.passthrough().parse(operation.parseInput(value));
    const controller = context.controllers.find((entry) => entry.id === controllerId); if (!controller) throw new Error("Unknown route controller");
    const result = snapshot.parse(await controller.run(["external-url", "console", "invoke", name, "--input", JSON.stringify(input)], { timeoutMilliseconds: 120_000 }));
    if (result.workspace !== input.workspace || result.workspaceId !== input.workspaceId) throw new Error("External routes returned another workspace identity");
    return result;
  } };
}
export const webPlugin: WebPlugin = {
  id: "external-urls", title: "External routes", description: "Expose workspace services through configured ingress routes", surfaces: ["workspace"], operations,
  assets: { "panel.js": new URL("./assets/panel.js", import.meta.url) }, browserEntry: "panel.js", autoConnect: automatic,
  async create() { throw new Error("Workspace routes require a selected DIM controller"); }
};
