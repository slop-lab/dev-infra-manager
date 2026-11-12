/** Workspace-side adapter. This module has no host/core dependency or upstream credential access. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type Model = { id: string; name: string; api: "responses" | "chat"; context?: number; output?: number };
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid DIM LLM connection");
  return value as Record<string, unknown>;
}
type TierModels = { quick: string; standard: string; deep: string };
function parseTierModels(value: unknown): TierModels {
  const tiers = record(value);
  if (Object.keys(tiers).length !== 3 || !["quick", "standard", "deep"].every((key) =>
    typeof tiers[key] === "string" && (tiers[key] as string).length > 0 && (tiers[key] as string).length <= 200
      && !/[\s\x00-\x1f\x7f]/.test(tiers[key] as string))) {
    throw new Error("DIM tiers must contain exactly quick, standard and deep model IDs");
  }
  return { quick: tiers.quick as string, standard: tiers.standard as string, deep: tiers.deep as string };
}
function validateTierModels(tiers: TierModels, models: readonly Model[]): void {
  for (const [tier, id] of Object.entries(tiers)) {
    const target = models.find((model) => model.id === id);
    if (!target || target.api !== "chat") throw new Error(`DIM tier '${tier}' requires an available chat route model`);
    if (models.some((model) => model.id === tier)) throw new Error(`DIM tier alias '${tier}' collides with a route model`);
  }
}
async function routeModels(endpoint: string, token: string): Promise<Model[]> {
  let response: Response;
  try {
    response = await fetch(`${endpoint}/v1/capabilities`, {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000)
    });
  } catch { throw new Error("DIM router model discovery failed; check the workspace router connection"); }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`DIM router model discovery failed (HTTP ${response.status}); check the workspace router connection`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("DIM router model catalogue exceeds the size limit");
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("DIM router model discovery failed; the catalogue is unavailable or exceeds the size limit");
  } finally { reader.releaseLock(); }
  let catalogue: Record<string, unknown>;
  try { catalogue = record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { throw new Error("invalid DIM router model catalogue"); }
  if (!Array.isArray(catalogue.models) || catalogue.models.length === 0) throw new Error("DIM router returned no route models");
  const ids = new Set<string>();
  return catalogue.models.map((value: unknown): Model => {
    const model = record(value);
    if (typeof model.id !== "string" || !/^[^\s\x00-\x1f\x7f]{1,200}$/.test(model.id) || ids.has(model.id)
      || typeof model.name !== "string" || model.name.length === 0 || (model.api !== "responses" && model.api !== "chat")
      || model.context !== undefined && (typeof model.context !== "number" || !Number.isSafeInteger(model.context) || model.context < 1)
      || model.output !== undefined && (typeof model.output !== "number" || !Number.isSafeInteger(model.output) || model.output < 1)) throw new Error("invalid DIM model metadata");
    ids.add(model.id);
    return { id: model.id, name: model.name, api: model.api,
      ...(model.context === undefined ? {} : { context: model.context }),
      ...(model.output === undefined ? {} : { output: model.output }) };
  });
}
/** Omitted limits let OpenCode retain its own catalog metadata, including input limits. */
function modelLimits(model: Model, configured?: unknown): Record<string, unknown> {
  const limit = { ...(model.context === undefined ? {} : { context: model.context }),
    ...(model.output === undefined ? {} : { output: model.output }),
    ...(configured === undefined ? {} : record(configured)) };
  return Object.keys(limit).length ? { limit } : {};
}
async function DimLlmRouter() {
  const nonce = process.env.DIM_LLM_ROUTER_REQUEST_NONCE;
  if (nonce !== undefined && !/^[a-f0-9]{32}$/.test(nonce)) throw new Error("DIM_LLM_ROUTER_REQUEST_NONCE must be a 32-character lowercase hex correlation value");
  const value: unknown = JSON.parse(await readFile(process.env.DIM_LLM_ROUTER_CONNECTION_FILE ?? join(homedir(), ".config/dim/llm-router.json"), "utf8"));
  const connection = record(value);
  if (connection.schemaVersion !== 1 || typeof connection.endpoint !== "string" || typeof connection.token !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(connection.token)) throw new Error("invalid DIM LLM connection");
  const url = new URL(connection.endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.origin !== connection.endpoint && connection.endpoint !== "http://127.0.0.1:19420/services/llm-router") throw new Error("invalid DIM LLM endpoint");
  const mode = process.env.DIM_LLM_ROUTER_OPENCODE_MODE ?? "router";
  if (mode !== "router" && mode !== "providers") throw new Error("DIM_LLM_ROUTER_OPENCODE_MODE must be router or providers");
  // The route owns the current catalogue; OpenCode and OMO own model choices.
  // Restarting OpenCode picks up newly allowed models without reattachment.
  const models = await routeModels(connection.endpoint, connection.token);
  const modelsById = new Map(models.map((model) => [model.id, model]));
  const tiers = connection.tiers === undefined ? undefined : parseTierModels(connection.tiers);
  if (tiers) {
    if (mode !== "router") throw new Error("DIM tiers require router mode");
    validateTierModels(tiers, models);
  }
  return { async "chat.params"(input: unknown, output?: unknown): Promise<void> {
    if (mode === "providers") return;
    const model = record(record(input).model);
    const routed = model.providerID === "openai" || model.providerID === "dim-responses" || model.providerID === "dim-chat";
    if (!routed) {
      if (tiers) throw new Error("DIM tier mode rejects unrouted provider calls");
      return;
    }
    if (tiers) {
      const id = model.id;
      if (model.providerID !== "dim-chat" || typeof id !== "string"
        || !Object.entries(tiers).some(([alias, target]) => id === alias || id === target)) {
        throw new Error("DIM tier mode requires a configured DIM tier model");
      }
      return;
    }
    const requestedId = model.id;
    const exact = typeof requestedId === "string" ? modelsById.get(requestedId) : undefined;
    const target = exact ?? (model.providerID === "openai" && typeof requestedId === "string" && requestedId.endsWith("-fast")
      ? modelsById.get(requestedId.slice(0, -5)) : undefined);
    const allowed = target && (model.providerID === `dim-${target.api}` || model.providerID === "openai" && target.api === "responses") ? target : undefined;
    if (!allowed) throw new Error(`DIM router model ${String(model.providerID)}/${String(requestedId)} is unavailable in the attached route; update the configured OpenCode or OMO model, or attach a route that offers it`);
    if (allowed.api === "responses" && output !== undefined) {
      const parameters = record(output);
      const options = parameters.options === undefined ? {} : record(parameters.options);
      if (options.previousResponseId !== undefined || options.previous_response_id !== undefined) {
        throw new Error("DIM router requires stateless full-history Responses requests");
      }
      parameters.options = { ...options, store: false };
    }
  }, async "chat.headers"(input: unknown, output: unknown): Promise<void> {
    const request = record(input), model = record(request.model);
    if (!["openai", "dim-responses", "dim-chat"].includes(String(model.providerID))
      || model.providerID === "openai" && mode === "providers") return;
    if (typeof request.sessionID !== "string" || request.sessionID.length === 0 || request.sessionID.length > 200
      || /[^A-Za-z0-9_.:-]/.test(request.sessionID)) {
      throw new Error("invalid DIM OpenCode session identity");
    }
    const result = record(output);
    const headers = result.headers === undefined ? {} : record(result.headers);
    result.headers = { ...headers, "x-dim-session-id": request.sessionID };
  }, async config(config: Record<string, unknown>): Promise<void> {
    const providers = config.provider === undefined ? {} : record(config.provider);
    if (tiers) {
      if (Array.isArray(config.disabled_providers) && config.disabled_providers.includes("dim-chat")) {
        throw new Error("DIM tier provider 'dim-chat' is disabled by OpenCode configuration");
      }
      if (providers["dim-chat"] !== undefined || providers["dim-responses"] !== undefined) throw new Error("DIM tier provider collision");
      providers["dim-chat"] = { npm: "@ai-sdk/openai-compatible", name: "DIM workspace tiers",
        options: { baseURL: `${connection.endpoint}/v1`, apiKey: connection.token, headerTimeout: false, chunkTimeout: false,
          ...(nonce === undefined ? {} : { headers: { "x-dim-request-nonce": nonce } }) },
        models: Object.fromEntries(Object.entries(tiers).map(([alias, id]) => {
          const target = modelsById.get(id)!;
          return [alias, { id: target.id, name: alias, ...modelLimits(target) }];
        })) };
      config.provider = providers;
      config.enabled_providers = ["dim-chat"];
      config.model = "dim-chat/standard";
      config.small_model = "dim-chat/quick";
      return;
    }
    for (const api of ["responses", "chat"] as const) {
      const selected = models.filter((model) => model.api === api); if (selected.length === 0) continue;
      const name = `dim-${api}`;
      if (providers[name] !== undefined) throw new Error(`OpenCode provider '${name}' already exists; refusing to replace it`);
      providers[name] = { npm: api === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible", name: "DIM workspace router",
        options: { baseURL: `${connection.endpoint}/v1`, apiKey: connection.token, headerTimeout: false, chunkTimeout: false,
          ...(nonce === undefined ? {} : { headers: { "x-dim-request-nonce": nonce } }) },
        models: Object.fromEntries(selected.map((model) => [model.id, { name: model.name, ...(api === "responses" ? { options: { store: false } } : {}), ...modelLimits(model) }])) };
    }
    config.provider = providers;
    if (mode === "router") {
      // Keep native OpenAI IDs so OMO's role models, variants and fallback chains
      // continue to work, including choices made after the config hook runs.
      const openai = providers.openai === undefined ? {} : record(providers.openai);
      const options = openai.options === undefined ? {} : record(openai.options);
      const configured = openai.models === undefined ? {} : record(openai.models);
      const responses = models.filter((model) => model.api === "responses");
      // OMO may request a -fast name absent from this account. Expose an alias
      // only when that exact name is absent and its unsuffixed model is served.
      const openaiModels = responses.flatMap((model) => [{ id: model.id, target: model },
        ...(model.id.length <= 195 && !modelsById.has(`${model.id}-fast`)
          ? [{ id: `${model.id}-fast`, target: model }] : [])]);
      const endpoint = connection.endpoint;
      const token = connection.token;
      const transport: typeof fetch = async (input, init) => {
        const requestUrl = new URL(input instanceof Request ? input.url : String(input));
        if (requestUrl.href !== `${endpoint}/v1/responses`) throw new Error("DIM OpenAI transport requires the attached Responses endpoint");
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        headers.set("authorization", `Bearer ${token}`);
        if (nonce !== undefined) headers.set("x-dim-request-nonce", nonce);
        return fetch(input, { ...init, headers, redirect: "error" });
      };
      providers.openai = { ...openai, npm: "@ai-sdk/openai", name: "OpenAI via DIM workspace router",
        whitelist: openaiModels.map(({ id }) => id),
        options: { ...options, baseURL: `${endpoint}/v1`, apiKey: token, fetch: transport,
          headerTimeout: options.headerTimeout ?? false, chunkTimeout: options.chunkTimeout ?? false },
        models: Object.fromEntries(openaiModels.map(({ id, target: model }) => {
          const existing = configured[id] === undefined ? {} : record(configured[id]);
          const modelOptions = existing.options === undefined ? {} : record(existing.options);
          return [id, { ...existing, ...(id === model.id ? {} : { id: model.id }), name: id === model.id ? model.name : `${id} (via ${model.id})`, options: { ...modelOptions, store: false },
            ...modelLimits(model, existing.limit) }];
        })) };
    }
  } };
}
export default DimLlmRouter;
