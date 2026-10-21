import { z } from "zod";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import type { WebPlugin, WebPluginContext, WebPluginRuntime } from "@slop-lab/dim-web/plugin-api";

const controllerId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const workspace = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,47}$/);
const workspaceId = z.string().uuid();
const tool = z.enum(["opencode", "codex"]);
const selection = z.object({ workspace, workspaceId }).strict();
const browserSelection = selection.extend({ controllerId });
const password = z.string().min(12).max(128).regex(/^[\x20-\x7e]+$/);
const publicUrl = z.string().max(4096).refine((value) => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password; } catch { return false; }
});
const approval = z.enum(["not-required", "pending", "approved", "revoked"]);
const externalUrl = z.object({ url: publicUrl, permalink: publicUrl.optional(), ingress: controllerId, approval }).strict();
const credentials = selection.extend({ username: z.string().min(1).max(128), password });
const routes = selection.extend({
  ingresses: z.array(z.object({ name: controllerId, description: z.string().max(2000), scheme: z.enum(["http", "https", "tcp"]), driver: z.string().max(128) }).strict()).max(128),
  routes: z.array(z.object({ id: z.string().uuid(), url: z.string().max(4096), permalink: z.string().max(4096).optional(), ingress: controllerId,
    approval, port: z.number().int().min(1).max(65535), containers: z.array(z.string().max(128)).max(128), protocol: z.enum(["http", "https", "tcp"]) }).strict()).max(1000)
});
const toolsStatus = selection.extend({ tools: z.array(z.object({ name: tool, version: z.string().max(1024), installed: z.boolean() }).strict()).max(2) });
const serverStatus = selection.extend({ state: z.enum(["running", "stopped"]), port: z.number().int().min(1).max(65535),
  url: z.string().max(256).refine((value) => /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(value)),
  username: z.string().max(128), credentialsFile: z.string().max(4096), logFile: z.string().max(4096),
  externalUrls: z.array(externalUrl).max(1000).optional(), externalUrlsAvailable: z.boolean().optional() });
const discoverySchema = z.object({ schemaVersion: z.literal(1), workspaces: z.array(z.object({ name: workspace, id: workspaceId, phase: z.string().min(1).max(64) }).strict()).max(1000), tools: z.array(tool).max(2) }).strict();
const controllerSchema = discoverySchema.omit({ schemaVersion: true }).extend({ id: controllerId, title: z.string().min(1).max(256), status: z.enum(["ready", "unavailable"]) });
const catalog: Operation = { name: "controllers.list", description: "Discover workspace tool controllers", access: "read",
  parseInput: (value) => z.object({}).strict().default({}).parse(value), parseOutput: (value) => z.object({ controllers: z.array(controllerSchema).max(64) }).strict().parse(value) };
function operation(name: string, description: string, access: "read" | "operator", setup = false): Operation {
  return { name, description, access,
    parseInput: (value) => (setup ? browserSelection.extend({ tool }) : name === "server.password" ? browserSelection.extend({ password }) : browserSelection).parse(value),
    parseOutput: (value) => (name.startsWith("tools.") ? toolsStatus : name === "server.credentials" ? credentials : serverStatus).parse(value) };
}
export const operations: readonly Operation[] = [catalog,
  operation("tools.status", "Inspect installed workspace tools", "read"),
  operation("tools.setup", "Install a workspace tool", "operator", true),
  operation("server.start", "Start the workspace OpenCode server", "operator"),
  operation("server.status", "Inspect the workspace OpenCode server", "read"),
  operation("server.stop", "Stop the workspace OpenCode server", "operator"),
  operation("server.credentials", "Read the OpenCode server password", "operator"),
  operation("server.password", "Set the OpenCode server password", "operator")];

async function automatic(context: WebPluginContext): Promise<WebPluginRuntime> {
  let controllers: Array<z.infer<typeof controllerSchema>> = [];
  async function discover() {
    controllers = await Promise.all(context.controllers.map(async (controller) => {
      try {
        const description = discoverySchema.parse(await controller.run(["tools", "console", "describe"]));
        return { id: controller.id, title: controller.id, status: "ready" as const, workspaces: description.workspaces, tools: description.tools };
      } catch { return { id: controller.id, title: controller.id, status: "unavailable" as const, workspaces: [], tools: [] }; }
    }));
    return { controllers };
  }
  await discover();
  return { operations, async invoke(name, value) {
    if (name === catalog.name) return catalog.parseOutput(await discover());
    const operation = operations.find((item) => item.name === name);
    if (!operation) throw new Error("Unknown workspace tools operation");
    const { controllerId: id, ...input } = z.record(z.string(), z.unknown()).parse(operation.parseInput(value));
    const controller = context.controllers.find((item) => item.id === id);
    const available = controllers.find((item) => item.id === id && item.status === "ready");
    if (!controller || !available) throw new Error("Workspace tools controller is unavailable");
    if (!available.workspaces.some((item) => item.name === input.workspace && item.id === input.workspaceId)) throw new Error("Workspace identity is outside this controller scope; refresh workspaces");
    if (name === "tools.setup" && !available.tools.includes(tool.parse(input.tool))) throw new Error("Workspace tool is unavailable");
    const timeoutMilliseconds = name === "tools.setup" ? 180_000 : ["server.start", "server.password"].includes(name) ? 90_000 : 30_000;
    const result = operation.parseOutput(await controller.run(name === "server.password"
      ? ["tools", "console", "invoke", name, "--input-stdin"]
      : ["tools", "console", "invoke", name, "--input", JSON.stringify(input)],
    { timeoutMilliseconds, ...(name === "server.password" ? { input: JSON.stringify(input) } : {}) }));
    const record = z.record(z.string(), z.unknown()).parse(result);
    const identity = selection.parse({ workspace: record.workspace, workspaceId: record.workspaceId });
    if (identity.workspace !== input.workspace || identity.workspaceId !== input.workspaceId) throw new Error("Workspace tools returned another workspace identity");
    if (!name.startsWith("server.") || name === "server.credentials") return result;
    const status = serverStatus.parse(result);
    try {
      const snapshot = routes.parse(await controller.run(["external-url", "console", "invoke", "routes.list", "--input", JSON.stringify(identity)], { timeoutMilliseconds: 30_000 }));
      if (snapshot.workspace !== identity.workspace || snapshot.workspaceId !== identity.workspaceId) throw new Error("External routes returned another workspace identity");
      const externalUrls = snapshot.routes.filter((route) => route.port === status.port && route.containers.length === 0 && route.protocol !== "tcp")
        .map((route) => externalUrl.parse({ url: route.url, ...(route.permalink ? { permalink: route.permalink } : {}), ingress: route.ingress, approval: route.approval }));
      return serverStatus.parse({ ...status, externalUrls, externalUrlsAvailable: true });
    } catch { return serverStatus.parse({ ...status, externalUrls: [], externalUrlsAvailable: false }); }
  } };
}
export const webPlugin: WebPlugin = {
  id: "agent-tools", title: "Workspace tools", description: "Install workspace tools and manage OpenCode servers", surfaces: ["workspace"], operations,
  assets: { "panel.js": new URL("./assets/panel.js", import.meta.url) }, browserEntry: "panel.js", autoConnect: automatic,
  async create() { throw new Error("Workspace tools require a selected DIM controller; use automatic connection"); }
};
