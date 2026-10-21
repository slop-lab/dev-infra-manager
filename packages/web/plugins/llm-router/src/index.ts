import { isAbsolute } from "node:path";
import { z } from "zod";
import { createLlmRouterClient, llmOperations } from "@slop-lab/dim-llm-router-client";
import type { WebPlugin } from "@slop-lab/dim-web/plugin-api";
const configuration = z.strictObject({ connectionFile: z.string().refine(isAbsolute) });
export const webPlugin: WebPlugin = {
  id: "llm-router", title: "LLM router", description: "Project routing, provider account health, request usage and workspace access",
  operations: llmOperations, assets: { "panel.js": new URL("./assets/panel.js", import.meta.url), "accounts.js": new URL("./assets/accounts.js", import.meta.url) }, browserEntry: "panel.js",
  async create(input) {
    const config = configuration.parse(input), client = createLlmRouterClient(config.connectionFile);
    const capabilities = await client.capabilities();
    return { operations: llmOperations.filter((operation) => capabilities.some(({ name }) => name === operation.name)), invoke: (name, input) => client.invoke(name, input) };
  }
};
