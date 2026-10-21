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
  expect(config).toMatchObject({ model: "dim-responses/reviewed", small_model: "dim-responses/reviewed", provider: {
    "dim-chat": { models: { added: { name: "Added", limit: { context: 64000, output: 8000 } } } },
    "dim-responses": { models: { reviewed: { name: "Reviewed" } } }
  } });
  await expect(hooks["chat.params"]({ model: { providerID: "dim-chat", id: "added" } })).resolves.toBeUndefined();
  await expect(hooks["chat.params"]({ model: { providerID: "dim-responses", id: "unlisted" } })).rejects.toThrow(/unattached/);
  // A subsequent OpenCode initialization observes route changes without writing
  // the connection file or rotating the scoped workspace credential.
  fetcher.mockResolvedValueOnce(Response.json({ models: [reviewed] }));
  const refreshed = await DimLlmRouter();
  await expect(refreshed["chat.params"]({ model: { providerID: "dim-chat", id: "added" } })).rejects.toThrow(/unattached/);
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
