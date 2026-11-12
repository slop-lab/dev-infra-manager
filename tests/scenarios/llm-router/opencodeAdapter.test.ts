import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import DimLlmRouter from "../../../packages/host/plugins/llm-router/src/opencode.js";

import { parseTierModels } from "../../../packages/host/plugins/llm-router/src/tier-models.js";

const roots: string[] = [];
const reviewed = { id: "reviewed", name: "Reviewed", api: "responses", context: 128000, output: 16000 };
const added = { id: "added", name: "Added", api: "chat", context: 64000, output: 8000 };
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(tiers?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "dim-opencode-catalogue-")); roots.push(root);
  const connection = join(root, "connection.json");
  vi.stubEnv("DIM_LLM_ROUTER_CONNECTION_FILE", connection);
  vi.stubEnv("DIM_LLM_ROUTER_OPENCODE_MODE", "router");
  const token = "x".repeat(43);
  await writeFile(connection, JSON.stringify({ schemaVersion: 1, endpoint: "http://127.0.0.1:8319", token, ...(tiers === undefined ? {} : { tiers }) }));
  return { token };
}
it("uses the authenticated current route catalogue without selecting main or background models", async () => {
  const { token } = await fixture();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [added, reviewed] }));
  vi.stubGlobal("fetch", fetcher);
  const hooks = await DimLlmRouter();
  expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8319/v1/capabilities", {
    headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: expect.any(AbortSignal)
  });
  const config: Record<string, unknown> = {};
  await hooks.config(config);
  expect(config).toMatchObject({ provider: {
    "dim-chat": { options: { chunkTimeout: false }, models: { added: { name: "Added", limit: { context: 64000, output: 8000 } } } },
    "dim-responses": { options: { chunkTimeout: false }, models: { reviewed: { name: "Reviewed" } } }
  } });
  expect(config).not.toHaveProperty("model");
  expect(config).not.toHaveProperty("small_model");
  await expect(hooks["chat.params"]({ model: { providerID: "dim-chat", id: "added" } })).resolves.toBeUndefined();
  await expect(hooks["chat.params"]({ model: { providerID: "dim-responses", id: "unlisted" } })).rejects.toThrow(/unavailable/);
  // A subsequent OpenCode initialization observes route changes without writing
  // the connection file or rotating the scoped workspace credential.
  fetcher.mockResolvedValueOnce(Response.json({ models: [added] }));
  const refreshed = await DimLlmRouter();
  await expect(refreshed["chat.params"]({ model: { providerID: "dim-chat", id: "added" } })).resolves.toBeUndefined();
  await expect(refreshed["chat.params"]({ model: { providerID: "dim-responses", id: "reviewed" } })).rejects.toThrow(/unavailable/);
});
it("fails clearly when discovery is unavailable rather than allowing the stale snapshot", async () => {
  await fixture();
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private upstream detail"));
  vi.stubGlobal("fetch", fetcher);
  await expect(DimLlmRouter()).rejects.toThrow(/^DIM router model discovery failed; check the workspace router connection$/);
  fetcher.mockResolvedValueOnce(new Response("private backend detail", { status: 401 }));
  await expect(DimLlmRouter()).rejects.toThrow(/HTTP 401/);
  fetcher.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
  await expect(DimLlmRouter()).rejects.toThrow(/size limit/);
});
it.each([
  [], [reviewed, reviewed], [{ ...reviewed, api: "image" }], [{ ...reviewed, output: 0 }]
])("rejects invalid catalogues (%j)", async (...models) => {
  await fixture();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models })));
  await expect(DimLlmRouter()).rejects.toThrow(/DIM/);
});

it("redirects only OpenAI while preserving OMO role models, variants, fallbacks and other providers", async () => {
  const { token } = await fixture();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [reviewed, added] }));
  vi.stubGlobal("fetch", fetcher);
  const hooks = await DimLlmRouter();
  const agent = {
    oracle: { model: "openai/reviewed", variant: "high", temperature: 0.2 },
    explore: { model: "anthropic/fast", variant: "max" },
    custom: { prompt: "preserve" }
  };
  const anthropic = { options: { baseURL: "https://other.example" } };
  const variants = { high: { reasoningEffort: "high" } };
  const config: Record<string, unknown> = { model: "openai/reviewed", small_model: "anthropic/fast", agent,
    provider: { anthropic, openai: { options: { apiKey: "old-key", baseURL: "https://api.openai.com/v1" },
      models: { reviewed: { variants, options: { reasoningEffort: "high" } } } } } };
  const originalAgents = structuredClone(agent);
  await hooks.config(config);
  expect(config.agent).toEqual(originalAgents);
  expect(config).toMatchObject({ model: "openai/reviewed", small_model: "anthropic/fast", provider: {
    anthropic, openai: { whitelist: ["reviewed", "reviewed-fast"], options: { baseURL: "http://127.0.0.1:8319/v1", apiKey: token, headerTimeout: false, chunkTimeout: false },
      models: { reviewed: { variants, options: { reasoningEffort: "high", store: false } } } }
  } });
  const parameters = { options: { reasoningEffort: "high", store: true } };
  await hooks["chat.params"]({ model: { providerID: "openai", id: "reviewed" } }, parameters);
  expect(parameters.options).toEqual({ reasoningEffort: "high", store: false });
  await expect(hooks["chat.params"]({ model: { providerID: "anthropic", id: "fast" } })).resolves.toBeUndefined();
  await expect(hooks["chat.params"]({ model: { providerID: "openai", id: "unknown" } })).rejects.toThrow("unavailable");
  const openai = (config.provider as Record<string, { options: { fetch: typeof fetch } }>).openai!;
  fetcher.mockResolvedValueOnce(Response.json({ status: "completed" }));
  await openai.options.fetch("http://127.0.0.1:8319/v1/responses", { headers: { authorization: "Bearer old-key" } });
  const sent = fetcher.mock.calls.at(-1)?.[1];
  expect(new Headers(sent?.headers).get("authorization")).toBe(`Bearer ${token}`);
  expect(sent?.redirect).toBe("error");
  await expect(openai.options.fetch("https://api.openai.com/v1/responses")).rejects.toThrow("attached Responses endpoint");
});

it("uses a -fast alias only when the exact model is absent and the unsuffixed Responses model exists", async () => {
  await fixture();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [reviewed, added] }));
  vi.stubGlobal("fetch", fetcher);
  const hooks = await DimLlmRouter();
  const agent = { explore: { model: "openai/reviewed-fast", variant: "high" } };
  const variants = { high: { reasoningEffort: "high" } };
  const config: Record<string, unknown> = { agent, provider: { openai: { models: { "reviewed-fast": { variants } } } } };
  await hooks.config(config);
  expect(config.agent).toEqual(agent);
  expect(config).toMatchObject({ provider: { openai: { whitelist: ["reviewed", "reviewed-fast"],
    models: { "reviewed-fast": { id: "reviewed", variants } } } } });
  await expect(hooks["chat.params"]({ model: { providerID: "openai", id: "reviewed-fast" } })).resolves.toBeUndefined();
  for (const id of ["unknown-fast", "added-fast", "reviewed-fast-fast"]) {
    await expect(hooks["chat.params"]({ model: { providerID: "openai", id } })).rejects.toThrow("unavailable");
  }
  const exactFast = { ...reviewed, id: "reviewed-fast", name: "Actual fast model" };
  fetcher.mockResolvedValueOnce(Response.json({ models: [reviewed, exactFast] }));
  const refreshed = await DimLlmRouter(), exactConfig: Record<string, unknown> = {};
  await refreshed.config(exactConfig);
  const provider = (exactConfig.provider as Record<string, { models: Record<string, { id?: string; name: string }> }>).openai!;
  expect(provider.models["reviewed-fast"]?.id).toBeUndefined();
  expect(provider.models["reviewed-fast"]?.name).toBe("Actual fast model");
  fetcher.mockResolvedValueOnce(Response.json({ models: [reviewed, { ...added, id: "reviewed-fast" }] }));
  const chatOnly = await DimLlmRouter(), chatConfig: Record<string, unknown> = {};
  await chatOnly.config(chatConfig);
  expect(chatConfig).toMatchObject({ provider: { openai: { whitelist: ["reviewed"] } } });
  await expect(chatOnly["chat.params"]({ model: { providerID: "openai", id: "reviewed-fast" } })).rejects.toThrow("unavailable");
});

it("leaves unknown model limits unset so OpenCode retains its native catalog and explicit user limits", async () => {
  await fixture();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [{ id: "native", name: "Native", api: "responses" }] })));
  const hooks = await DimLlmRouter();
  const config: Record<string, unknown> = {};
  await hooks.config(config);
  const providers = config.provider as Record<string, { models: Record<string, { id?: string; limit?: unknown }> }>;
  expect(providers.openai!.models.native).not.toHaveProperty("limit");
  expect(providers.openai!.models["native-fast"]).toMatchObject({ id: "native" });
  expect(providers.openai!.models["native-fast"]).not.toHaveProperty("limit");
  expect(providers["dim-responses"]!.models.native).not.toHaveProperty("limit");
  const explicit: Record<string, unknown> = { provider: { openai: { models: { native: { limit: { context: 1050000, input: 922000, output: 128000 } } } } } };
  await hooks.config(explicit);
  expect(explicit).toMatchObject({ provider: { openai: { models: { native: { limit: { context: 1050000, input: 922000, output: 128000 } } } } } });
});

it.each([false, 2345])("preserves explicit OpenCode chunk deadline %s while disabling only absent deadlines", async (chunkTimeout) => {
  await fixture();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [reviewed] })));
  const hooks = await DimLlmRouter(), config: Record<string, unknown> = { provider: { openai: { options: { headerTimeout: 1234, chunkTimeout } } } };
  await hooks.config(config);
  expect(config).toMatchObject({ provider: { openai: { options: { headerTimeout: 1234, chunkTimeout } }, "dim-responses": { options: { headerTimeout: false, chunkTimeout: false } } } });
});

const tierTargets = { quick: "auto:dim-quick", standard: "auto:dim-standard", deep: "auto:dim-deep" };
const tierCatalogue = Object.values(tierTargets).map((id) => ({ ...added, id }));
it("uses strict authenticated tier aliases and refuses both stale and unrouted selections", async () => {
  await fixture(tierTargets);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ models: tierCatalogue })));
  const hooks = await DimLlmRouter(), config: Record<string, unknown> = { provider: { bigpickle: { name: "User" } }, model: "bigpickle/free" };
  await hooks.config(config);
  expect(config).toMatchObject({ model: "dim-chat/standard", small_model: "dim-chat/quick", enabled_providers: ["dim-chat"],
    provider: { "dim-chat": { models: { quick: { id: tierTargets.quick, limit: { context: 64000, output: 8000 } } } } } });
  for (const id of ["quick", "standard", "deep", ...Object.values(tierTargets)]) {
    await expect(hooks["chat.params"]({ model: { providerID: "dim-chat", id } })).resolves.toBeUndefined();
  }
  for (const providerID of ["bigpickle", "anthropic", "openai"]) {
    await expect(hooks["chat.params"]({ model: { providerID, id: "free" } })).rejects.toThrow(/tier mode/);
  }
  await expect(hooks["chat.params"]({ model: { providerID: "dim-chat", id: "not-selected" } })).rejects.toThrow(/tier mode/);
  await expect(hooks.config({ provider: { "dim-chat": {} } })).rejects.toThrow(/collision/);
  await expect(hooks.config({ disabled_providers: ["dim-chat"] })).rejects.toThrow(/disabled/);
});
it.each([
  { quick: "unknown", standard: tierTargets.standard, deep: tierTargets.deep },
  tierTargets,
])("rejects missing tier targets or wrong API without fallback", async (tiers) => {
  await fixture(tiers);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ models: [reviewed] })));
  await expect(DimLlmRouter()).rejects.toThrow(/available chat route/);
});
it("rejects alias collisions and contradictory providers-only tier mode", async () => {
  await fixture(tierTargets);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ models: [...tierCatalogue, { ...added, id: "quick" }] })));
  await expect(DimLlmRouter()).rejects.toThrow(/collides/);
  vi.stubEnv("DIM_LLM_ROUTER_OPENCODE_MODE", "providers");
  await expect(DimLlmRouter()).rejects.toThrow(/require router/);
});
it.each([{}, { ...tierTargets, extra: "oops" }, { ...tierTargets, quick: "bad\nheader" }, { ...tierTargets, deep: 4 }, { ...tierTargets, quick: "auto:fast\n" }])(
  "rejects malformed tier configuration (%j)", (value) => { expect(() => parseTierModels(value)).toThrow(/exactly quick/); });
it("adds only validated routed session identity headers in both ordinary and tier configurations", async () => {
  await fixture();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ models: [reviewed] })));
  const hooks = await DimLlmRouter(), output = { headers: { existing: "keep" } };
  await hooks["chat.headers"]({ sessionID: "ses_scope:1", model: { providerID: "openai" } }, output);
  expect(output.headers).toEqual({ existing: "keep", "x-dim-session-id": "ses_scope:1" });
  await expect(hooks["chat.headers"]({ sessionID: "bad\r\nheader", model: { providerID: "dim-chat" } }, {})).rejects.toThrow(/session identity/);
  await expect(hooks["chat.headers"]({ sessionID: "ses_trailing\n", model: { providerID: "dim-chat" } }, {})).rejects.toThrow(/session identity/);
  const unrelated = { headers: { existing: "only" } };
  await hooks["chat.headers"]({ model: { providerID: "anthropic" } }, unrelated);
  expect(unrelated).toEqual({ headers: { existing: "only" } });
  vi.stubEnv("DIM_LLM_ROUTER_OPENCODE_MODE", "providers");
  const independent = await DimLlmRouter();
  await independent["chat.headers"]({ model: { providerID: "openai" } }, unrelated);
  expect(unrelated).toEqual({ headers: { existing: "only" } });
});
