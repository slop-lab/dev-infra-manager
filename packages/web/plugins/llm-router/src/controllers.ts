import { z } from "zod";
import { llmOperations } from "@slop-lab/dim-llm-router-client";
import type { Operation } from "@slop-lab/dim-contracts-operations";
import type { WebPluginContext, WebPluginRuntime } from "@slop-lab/dim-web/plugin-api";
const controllerId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const descriptor = z.strictObject({ name: z.string(), description: z.string().max(2000), access: z.enum(["read", "operator", "reviewer"]) });
const controllerSchema = z.strictObject({ id: controllerId, controllerKey: controllerId, title: z.string().min(1).max(256), status: z.enum(["ready", "unavailable"]), operations: z.array(descriptor).max(1000) });
const descriptionSchema = z.strictObject({ schemaVersion: z.literal(1), selectionId: z.string().regex(/^[a-f0-9]{64}$/), operations: z.array(descriptor).max(1000) });
export const controllerOperation: Operation = { name: "controllers.list", description: "Discover LLM router connections on configured controllers", access: "read", parseInput: (value) => z.strictObject({}).default({}).parse(value), parseOutput: (value) => z.strictObject({ controllers: z.array(controllerSchema).max(64) }).parse(value) };
export function controllerScoped(operation: Operation): Operation {
  return { ...operation, parseInput(value) {
    const { controllerId: selected, ...input } = z.record(z.string(), z.unknown()).parse(value);
    return { controllerId: controllerId.parse(selected), ...z.record(z.string(), z.unknown()).parse(operation.parseInput(input)) };
  } };
}
/** The controller resolves its own private selected service connection. Web forwards operation data only. */
export async function automaticRouterConnections(context: WebPluginContext): Promise<WebPluginRuntime> {
  let controllers: Array<z.infer<typeof controllerSchema>> = [];
  const selections = new Map<string, string>();
  async function discover() {
    controllers = await Promise.all(context.controllers.map(async (controller) => {
      try {
        const expected = selections.get(controller.id);
        const description = descriptionSchema.parse(await controller.run(["llm-router", "console", "describe", ...(expected ? ["--expected-selection", expected] : []), "--json"]));
        if (expected && description.selectionId !== expected) throw new Error("Selected router connection changed; reconnect this feature");
        for (const operation of description.operations) if (!llmOperations.some((known) => known.name === operation.name && known.access === operation.access)) throw new Error("Unknown router capability");
        selections.set(controller.id, description.selectionId);
        return { id: controller.id, controllerKey: controller.id, title: controller.id, status: "ready" as const, operations: description.operations };
      } catch { return { id: controller.id, controllerKey: controller.id, title: controller.id, status: "unavailable" as const, operations: [] }; }
    }));
    return { controllers };
  }
  await discover();
  return { operations: [controllerOperation, ...llmOperations.map(controllerScoped)], async invoke(name, raw) {
    if (name === "controllers.list") return discover();
    const { controllerId: selected, ...input } = z.record(z.string(), z.unknown()).parse(raw);
    const id = controllerId.parse(selected), controller = context.controllers.find((value) => value.id === id);
    const operation = llmOperations.find((value) => value.name === name);
    if (!controller || !operation || !controllers.some((value) => value.id === id && value.status === "ready" && value.operations.some((available) => available.name === name))) throw new Error("Controller router operation is unavailable");
    const selection = selections.get(id); if (!selection) throw new Error("Router connection has not been attested");
    return operation.parseOutput(await controller.run(["llm-router", "console", "invoke", name, "--expected-selection", selection, "--input", "-", "--json"], { input: JSON.stringify(operation.parseInput(input)), timeoutMilliseconds: name === "account.login.start" ? 60_000 : 30_000 }));
  } };
}
