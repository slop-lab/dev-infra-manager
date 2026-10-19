/** Workspace-side adapter. This module has no host/core dependency or upstream credential access. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type Model = { id: string; name: string; api: "responses" | "chat"; context: number; output: number };
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid DIM LLM connection");
  return value as Record<string, unknown>;
}
async function DimLlmRouter() {
  const value: unknown = JSON.parse(await readFile(process.env.DIM_LLM_ROUTER_CONNECTION_FILE ?? join(homedir(), ".config/dim/llm-router.json"), "utf8"));
  const connection = record(value);
  if (connection.schemaVersion !== 1 || typeof connection.endpoint !== "string" || typeof connection.token !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(connection.token) || !Array.isArray(connection.models)) throw new Error("invalid DIM LLM connection");
  const url = new URL(connection.endpoint);
  if (url.origin !== connection.endpoint || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid DIM LLM endpoint");
  const models = connection.models.map((value: unknown): Model => {
    const model = record(value);
    if (typeof model.id !== "string" || typeof model.name !== "string" || (model.api !== "responses" && model.api !== "chat")
      || typeof model.context !== "number" || !Number.isSafeInteger(model.context) || model.context < 1
      || typeof model.output !== "number" || !Number.isSafeInteger(model.output) || model.output < 1) throw new Error("invalid DIM model metadata");
    return { id: model.id, name: model.name, api: model.api, context: model.context, output: model.output };
  });
  const mode = process.env.DIM_LLM_ROUTER_OPENCODE_MODE ?? "router";
  if (mode !== "router" && mode !== "providers") throw new Error("DIM_LLM_ROUTER_OPENCODE_MODE must be router or providers");
  const selected = models.find((model) => model.id === connection.defaultModel) ?? models[0];
  if (!selected || connection.defaultModel !== undefined && selected.id !== connection.defaultModel) throw new Error("DIM default model is not in the attached route");
  const selection = `dim-${selected.api}/${selected.id}`;
  return { async "chat.params"(input: unknown, output?: unknown): Promise<void> {
    if (mode === "providers") return;
    const model = record(record(input).model);
    const allowed = models.find((candidate) => model.providerID === `dim-${candidate.api}` && model.id === candidate.id);
    if (!allowed) {
      throw new Error("DIM router mode rejects an unattached model/provider; use DIM_LLM_ROUTER_OPENCODE_MODE=providers to opt out");
    }
    if (allowed.api === "responses" && output !== undefined) {
      const parameters = record(output);
      const options = parameters.options === undefined ? {} : record(parameters.options);
      if (options.previousResponseId !== undefined || options.previous_response_id !== undefined) {
        throw new Error("DIM router requires stateless full-history Responses requests");
      }
      parameters.options = { ...options, store: false };
    }
  }, async config(config: Record<string, unknown>): Promise<void> {
    const providers = config.provider === undefined ? {} : record(config.provider);
    for (const api of ["responses", "chat"] as const) {
      const selected = models.filter((model) => model.api === api); if (selected.length === 0) continue;
      const name = `dim-${api}`;
      if (providers[name] !== undefined) throw new Error(`OpenCode provider '${name}' already exists; refusing to replace it`);
      providers[name] = { npm: api === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible", name: "DIM workspace router",
        options: { baseURL: `${connection.endpoint}/v1`, apiKey: connection.token },
        models: Object.fromEntries(selected.map((model) => [model.id, { name: model.name, ...(api === "responses" ? { options: { store: false } } : {}), limit: { context: model.context, output: model.output } }])) };
    }
    config.provider = providers;
    if (mode === "router") {
      config.model = selection;
      config.small_model = selection;
      if (config.agent !== undefined) {
        for (const value of Object.values(record(config.agent))) {
          const agent = record(value);
          agent.model = selection;
          delete agent.variant;
        }
      }
    }
  } };
}
export default DimLlmRouter;
