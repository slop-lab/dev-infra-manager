import { automaticRouterConnections, controllerOperation, controllerScoped } from "./controllers.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createLlmRouterClient, LlmRouterResultUnavailableError } from "@slop-lab/dim-service-client-llm-router";
import { llmOperations } from "@slop-lab/dim-contracts-llm-router";
import { HttpResponseError, type WebPlugin } from "@slop-lab/dim-web/plugin-api";
const configuration = z.strictObject({ connectionFile: z.string().refine(isAbsolute) });
export const webPlugin: WebPlugin = {
  id: "llm-router", title: "LLM router", description: "Project routing, provider account health, request usage and workspace access",
  operations: [controllerOperation, ...llmOperations.map(controllerScoped)], autoConnect: automaticRouterConnections, assets: { "controllers.js": new URL("./assets/controllers.js", import.meta.url), "panel.js": new URL("./assets/panel.js", import.meta.url), "accounts.js": new URL("./assets/accounts.js", import.meta.url), "traffic.js": new URL("./assets/traffic.js", import.meta.url), "routes.js": new URL("./assets/routes.js", import.meta.url), "mutation-reconciliation.js": new URL("./assets/mutation-reconciliation.js", import.meta.url), "router.css": new URL("./assets/router.css", import.meta.url) }, browserEntry: "panel.js",
  async create(input) {
    const config = configuration.parse(input);
    const selectionId = await createLlmRouterClient(config.connectionFile).selectionId();
    const client = createLlmRouterClient(config.connectionFile, { expectedSelectionId: selectionId });
    const capabilities = await client.capabilities();
    return { operations: llmOperations.filter((operation) => capabilities.some(({ name, access }) => name === operation.name && access === operation.access)), async invoke(name, input) {
      try { return await client.invoke(name, input); }
      catch (error) {
        if (error instanceof LlmRouterResultUnavailableError) throw new HttpResponseError(503, "The LLM router did not return a reliable operation result. Refresh router state before retrying; your input is kept.", "llm_result_unavailable");
        throw error;
      }
    } };
  }
};
