import { isAbsolute } from "node:path";
import { z } from "zod";
import type { WebPlugin, WebPluginContext, WebPluginRuntime } from "@slop-lab/dim-web/plugin-api";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import { createExecutionConsole, executionOperations } from "@slop-lab/dim-service-client-execution";

const privatePath = z.string().refine(isAbsolute, "connection path must be absolute");
const configSchema = z.object({ queryConnection: privatePath, operatorConnection: privatePath.optional() }).strict();
export const operations = executionOperations;
const controllerId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const descriptor = z.object({ name: z.string(), description: z.string().max(2000), access: z.enum(["read", "operator", "reviewer"]) }).strict();
const controllerSchema = z.object({ id: controllerId, controllerKey: controllerId.optional(), title: z.string().min(1).max(256), status: z.enum(["ready", "unavailable"]), operations: z.array(descriptor).max(128) }).strict();
const discoverySchema = z.object({ schemaVersion: z.literal(1), generationId: z.string().regex(/^[a-f0-9]{64}$/), operations: z.array(descriptor).max(128) }).strict();
const catalogOperation: Operation = { name: "controllers.list", description: "Discover execution controllers", access: "read",
  parseInput: (input) => z.object({}).strict().default({}).parse(input), parseOutput: (output) => z.object({ controllers: z.array(controllerSchema).max(64) }).strict().parse(output) };
function wrapped(operation: Operation): Operation {
  return { ...operation, parseInput(value) {
    const { controllerId: selected, ...input } = z.record(z.string(), z.unknown()).parse(value);
    return { controllerId: controllerId.parse(selected), ...z.record(z.string(), z.unknown()).parse(operation.parseInput(input)) };
  } };
}
async function automatic(context: WebPluginContext): Promise<WebPluginRuntime> {
  let controllers: Array<z.infer<typeof controllerSchema>> = [];
  const generations = new Map<string, string>();
  async function discover() {
    controllers = await Promise.all(context.controllers.map(async (controller) => {
      try {
        const expected = generations.get(controller.id);
        const description = discoverySchema.parse(await controller.run(["execution", "console", "describe", ...(expected ? ["--expected-generation", expected] : [])]));
        if (expected && expected !== description.generationId) throw new Error("Execution generation changed; reconnect this feature");
        for (const operation of description.operations) if (!operations.some((known) => known.name === operation.name && known.access === operation.access)) throw new Error("Unknown execution operation");
        generations.set(controller.id, description.generationId);
        return { id: controller.id, controllerKey: controller.id, title: controller.id, status: "ready" as const, operations: description.operations };
      } catch { return { id: controller.id, controllerKey: controller.id, title: controller.id, status: "unavailable" as const, operations: [] }; }
    }));
    return { controllers };
  }
  await discover();
  return { operations: [catalogOperation, ...operations.map(wrapped)], async invoke(name, raw) {
    if (name === "controllers.list") return discover();
    const { controllerId: selected, ...input } = z.record(z.string(), z.unknown()).parse(raw);
    const id = controllerId.parse(selected), controller = context.controllers.find((controller) => controller.id === id);
    const operation = operations.find((operation) => operation.name === name);
    if (!controller || !operation || !controllers.some((entry) => entry.id === id && entry.status === "ready" && entry.operations.some((available) => available.name === name))) throw new Error("Controller operation is unavailable");
    const generation = generations.get(id); if (!generation) throw new Error("Execution generation has not been attested");
    return operation.parseOutput(await controller.run(["execution", "console", "invoke", name, "--expected-generation", generation, "--input", JSON.stringify(operation.parseInput(input))]));
  } };
}
export const webPlugin: WebPlugin = {
  id: "execution", title: "Execution", description: "CI jobs, diagnostic logs and worker capacity", operations: [catalogOperation, ...operations.map(wrapped)],
  assets: { "panel.js": new URL("./assets/panel.js", import.meta.url), "navigation.js": new URL("./assets/navigation.js", import.meta.url) }, browserEntry: "panel.js",
  autoConnect: automatic,
  async create(input) {
    const config = configSchema.parse(input);
    return createExecutionConsole({ queryConnection: config.queryConnection,
      ...(config.operatorConnection === undefined ? {} : { operatorConnection: config.operatorConnection }) });
  }
};
