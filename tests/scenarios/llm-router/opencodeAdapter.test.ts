import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import DimLlmRouter from "../../../packages/host/plugins/llm-router/src/opencode.js";

const roots: string[] = [];
const reviewed = { id: "reviewed", name: "Reviewed", api: "responses", context: 128000, output: 16000 };
const added = { id: "added", name: "Added", api: "chat", context: 64000, output: 8000 };
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-opencode-catalogue-")); roots.push(root);
  const connection = join(root, "connection.json");
  vi.stubEnv("DIM_LLM_ROUTER_CONNECTION_FILE", connection);
  vi.stubEnv("DIM_LLM_ROUTER_OPENCODE_MODE", "router");
  const token = "x".repeat(43);
  await writeFile(connection, JSON.stringify({ schemaVersion: 1, endpoint: "http://127.0.0.1:8319", token,
    defaultModel: reviewed.id, models: [reviewed] }));
  return { token };
}
it("uses the authenticated current route catalogue instead of the attachment snapshot, retaining the selected default", async () => {
  const { token } = await fixture();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ models: [added, reviewed] }));
  vi.stubGlobal("fetch", fetcher);
  const hooks = await DimLlmRouter();
  expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8319/v1/capabilities", {
    headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: expect.any(AbortSignal)
  });
  const config: Record<string, unknown> = {};
  await hooks.config(config);
  expect(config).toMatchObject({ model: "openai/reviewed", small_model: "openai/reviewed", provider: {
    "dim-chat": { models: { added: { name: "Added", limit: { context: 64000, output: 8000 } } } },
    "dim-responses": { models: { reviewed: { name: "Reviewed" } } }
  } });
  await expect(hooks["chat.params"]({ model: { providerID: "dim-chat", id: "added" } })).resolves.toBeUndefined();
  await expect(hooks["chat.params"]({ model: { providerID: "dim-responses", id: "unlisted" } })).rejects.toThrow(/unavailable/);
  // A subsequent OpenCode initialization observes route changes without writing
  // the connection file or rotating the scoped workspace credential.
  fetcher.mockResolvedValueOnce(Response.json({ models: [reviewed] }));
  const refreshed = await DimLlmRouter();
  await expect(refreshed["chat.params"]({ model: { providerID: "dim-chat", id: "added" } })).rejects.toThrow(/unavailable/);
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
  [], [added], [reviewed, reviewed], [{ ...reviewed, api: "image" }], [{ ...reviewed, output: 0 }]
])("rejects invalid catalogues and removal of the configured default (%j)", async (...models) => {
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
    anthropic, openai: { whitelist: ["reviewed"], options: { baseURL: "http://127.0.0.1:8319/v1", apiKey: token },
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
