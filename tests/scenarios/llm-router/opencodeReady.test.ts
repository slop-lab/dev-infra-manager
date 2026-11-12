import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { verifyOpenCodeServer } from "../../../packages/host/plugins/llm-router/src/opencode-ready.js";

it("validates tier aliases and defaults without requiring a native OpenAI provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-tier-ready-")), credentials = join(root, "auth"), connection = join(root, "connection.json");
  const endpoint = "http://127.0.0.1:19420/services/llm-router", token = "x".repeat(43);
  const tiers = { quick: "auto:fast", standard: "auto:balanced", deep: "auto:smart" };
  const config: Record<string, unknown> = { model: "dim-chat/standard", small_model: "dim-chat/quick", enabled_providers: ["dim-chat"], provider: { "dim-chat": {
    options: { baseURL: `${endpoint}/v1`, apiKey: token }, models: Object.fromEntries(Object.entries(tiers).map(([tier, id]) => [tier, { id }]))
  } } };
  const server = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(config)); });
  try {
    await writeFile(credentials, "fixture\nprivate-fixture\n", { mode: 0o600 });
    await writeFile(connection, JSON.stringify({ endpoint, token, tiers }), { mode: 0o600 });
    vi.stubEnv("DIM_LLM_ROUTER_CONNECTION_FILE", connection); vi.stubEnv("DIM_LLM_ROUTER_OPENCODE_MODE", "router");
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw Error("listener missing");
    await expect(verifyOpenCodeServer(credentials, address.port)).resolves.toBeUndefined();
    for (const change of [{ model: "opencode/big-pickle" }, { enabled_providers: ["dim-chat", "openai"] }, { disabled_providers: ["dim-chat"] },
      { provider: { "dim-chat": { models: { standard: { id: "wrong-target" } } } } }]) {
      const original = { ...config }; Object.assign(config, change);
      await expect(verifyOpenCodeServer(credentials, address.port)).rejects.toThrow(/selected tiers/);
      for (const key of Object.keys(config)) delete config[key]; Object.assign(config, original);
    }
    vi.stubEnv("DIM_LLM_ROUTER_OPENCODE_MODE", "providers");
    await expect(verifyOpenCodeServer(credentials, address.port)).rejects.toThrow(/tier configuration/);
  } finally {
    vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["router", "providers"])("revalidates %s routing and actual agent inventory without changing selected roles or authentication", async (mode) => {
  const root = await mkdtemp(join(tmpdir(), "dim-opencode-ready-")), credentials = join(root, "auth"), connection = join(root, "connection.json");
  const endpoint = "http://127.0.0.1:19420/services/llm-router", token = "x".repeat(43);
  const config = { default_agent: "selected-role", agent: { "selected-role": { model: "openai/reviewed", variant: "high" } }, provider: { [mode === "providers" ? "dim-responses" : "openai"]: { options: { baseURL: `${endpoint}/v1`, apiKey: token } } } };
  const original = JSON.stringify(config); let routed = false, available = false;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from("fixture:private-fixture").toString("base64")}`) { response.writeHead(401).end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/agent" ? available ? [{ name: "selected-role" }] : []
      : routed ? config : { ...config, provider: {} }));
  });
  try {
    await writeFile(credentials, "fixture\nprivate-fixture\n", { mode: 0o600 });
    await writeFile(connection, JSON.stringify({ endpoint, token }), { mode: 0o600 }); vi.stubEnv("DIM_LLM_ROUTER_CONNECTION_FILE", connection);
    vi.stubEnv("DIM_LLM_ROUTER_OPENCODE_MODE", mode);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("listener missing");
    await expect(verifyOpenCodeServer(credentials, address.port)).rejects.toThrow();
    routed = true;
    await expect(verifyOpenCodeServer(credentials, address.port)).rejects.toThrow(/primary agent is absent/);
    available = true;
    await expect(verifyOpenCodeServer(credentials, address.port)).resolves.toBeUndefined();
    expect(JSON.stringify(config)).toBe(original);
    expect(await readFile(credentials, "utf8")).toBe("fixture\nprivate-fixture\n");
  } finally {
    vi.unstubAllEnvs(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
