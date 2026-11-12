import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "jsonc-parser";
import DimLlmRouter from "../../../packages/host/plugins/llm-router/src/opencode.js";
import { prepareOpenCode } from "../../../packages/host/plugins/llm-router/src/opencode-launch.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(tiers?: unknown) {
  const home = await mkdtemp(join(tmpdir(), "dim-opencode-profile-")); roots.push(home);
  vi.stubEnv("HOME", home); vi.stubEnv("DIM_LLM_ROUTER_OPENCODE_MODE", "router");
  vi.stubEnv("XDG_CACHE_HOME", join(home, ".cache"));
  vi.stubEnv("OPENCODE_CONFIG_CONTENT", '{"permission":{"bash":"ask"},"model":"explicit/original"}');
  const connection = join(home, "connection.json"); vi.stubEnv("DIM_LLM_ROUTER_CONNECTION_FILE", connection);
  await writeFile(connection, JSON.stringify({ schemaVersion: 1, endpoint: "http://127.0.0.1:8319", token: "x".repeat(43), ...(tiers === undefined ? {} : { tiers }) }), { mode: 0o600 });
  await mkdir(join(home, ".omo")); await mkdir(join(home, ".local/lib/node_modules"), { recursive: true });
  const require = createRequire(import.meta.url);
  await symlink(dirname(require.resolve("jsonc-parser/package.json")), join(home, ".local/lib/node_modules/jsonc-parser"));
  const adapter = join(home, ".config/opencode/plugins/dim-llm-router.js"); await mkdir(dirname(adapter), { recursive: true });
  await writeFile(adapter, await readFile(new URL("../../../packages/host/plugins/llm-router/dist/opencode.js", import.meta.url)));
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ models: [{ id: "reviewed", name: "Reviewed", api: "responses" }] })));
  return { home, connection, omo: join(home, ".omo/omo.jsonc") };
}
it("preserves OMO inventory while probing the router across failed discovery and recovery", async () => {
  const fx = await fixture();
  const inventory = join(fx.home, ".cache/oh-my-opencode");
  const authentication = join(fx.home, ".local/share/opencode/auth.json");
  const session = join(fx.home, ".local/share/opencode/storage/session/user-session.json");
  const original = '{"agents":{"oracle":{"model":"openai/reviewed","variant":"high"}},"categories":{"quick":{"model":"anthropic/fast"}}}';
  await mkdir(inventory, { recursive: true });
  await mkdir(dirname(authentication), { recursive: true });
  await mkdir(dirname(session), { recursive: true });
  await writeFile(join(inventory, "connected-providers.json"), '{"connected":["openai"],"updatedAt":"stale"}');
  await writeFile(join(inventory, "provider-models.json"), '{"models":{"openai":[{"id":"removed"}]},"connected":["openai"],"updatedAt":"stale"}');
  await writeFile(join(inventory, "model-capabilities.json"), '{"user":"preserved"}');
  await writeFile(authentication, '{"openai":{"type":"oauth"}}', { mode: 0o600 });
  await writeFile(session, '{"id":"user-session"}', { mode: 0o600 });
  await writeFile(fx.omo, original, { mode: 0o600 });
  const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("route unavailable"));
  vi.stubGlobal("fetch", fetcher);

  await expect(prepareOpenCode()).rejects.toThrow("DIM router model discovery failed; check the workspace router connection");

  expect(await readFile(join(inventory, "connected-providers.json"), "utf8")).toBe('{"connected":["openai"],"updatedAt":"stale"}');
  expect(await readFile(join(inventory, "provider-models.json"), "utf8")).toBe('{"models":{"openai":[{"id":"removed"}]},"connected":["openai"],"updatedAt":"stale"}');
  expect(await readFile(join(inventory, "model-capabilities.json"), "utf8")).toBe('{"user":"preserved"}');
  expect(await readFile(authentication, "utf8")).toBe('{"openai":{"type":"oauth"}}');
  expect(await readFile(session, "utf8")).toBe('{"id":"user-session"}');
  expect(await readFile(fx.omo, "utf8")).toBe(original);

  fetcher.mockImplementation(async () => Response.json({ models: [
    { id: "reviewed", name: "Reviewed", api: "responses", context: 128000, output: 16000 },
  ] }));
  await prepareOpenCode();
  const recovered = await DimLlmRouter();
  await expect(recovered["chat.params"]({ model: { providerID: "openai", id: "reviewed" } })).resolves.toBeUndefined();
  await expect(recovered["chat.params"]({ model: { providerID: "openai", id: "removed" } })).rejects.toThrow(/openai\/removed/);
  expect(await readFile(fx.omo, "utf8")).toBe(original);
});
it("preserves role model chains, variants, profiles and explicit launch options", async () => {
  const fx = await fixture();
  vi.stubEnv("OMO_PROFILE", "personal");
  const original = `{
  // retain this user explanation
  "agents": {"oracle":{"models":["openai/reasoning(high)","anthropic/fallback"],"variant":"high","prompt":"preserve"}},
  "[opencode]": {"categories":{"quick":{"models":["openai/fast"],"variant":"low"}},"runtime_fallback":true},
  "profiles":{"personal":{"[opencode]":{"agents":{"sisyphus":{"models":["google/primary","openai/backup"]}}}}},
}`;
  await writeFile(fx.omo, original, { mode: 0o600 });
  expect(await prepareOpenCode()).toEqual({});
  expect(await readFile(fx.omo, "utf8")).toBe(original);
  expect(process.env.OPENCODE_CONFIG_CONTENT).toBe('{"permission":{"bash":"ask"},"model":"explicit/original"}');
  expect(process.env.OMO_PROFILE).toBe("personal");
  vi.stubEnv("DIM_LLM_ROUTER_OPENCODE_MODE", "providers");
  expect(await prepareOpenCode()).toEqual({});
  expect(await readFile(fx.omo, "utf8")).toBe(original);
});
it("removes only the exact owned generated profile while preserving user configuration", async () => {
  const fx = await fixture();
  const owned = { "[opencode]": { agents: { oracle: { models: ["dim-responses/reviewed"] } }, runtime_fallback: false } };
  const original = `{
  // retain model chains and selected profiles
  "agents":{"oracle":{"models":["openai/reasoning(high)","anthropic/fallback"]}},
  "profiles":{"personal":{"[opencode]":{"categories":{"quick":{"models":["google/fast"]}}}},"dim-router":${JSON.stringify(owned)}},
  "_migrations":{"model-chains":true},
}`;
  const metadata = join(fx.home, ".config/dim/opencode-omo-profile.json");
  await mkdir(dirname(metadata), { recursive: true });
  await writeFile(metadata, JSON.stringify(owned), { mode: 0o600 });
  await writeFile(fx.omo, original, { mode: 0o600 });
  expect(await prepareOpenCode()).toEqual({});
  const source = await readFile(fx.omo, "utf8");
  expect(source).toContain("// retain model chains and selected profiles");
  expect(parse(source)).toEqual({
    agents: { oracle: { models: ["openai/reasoning(high)", "anthropic/fallback"] } },
    profiles: { personal: { "[opencode]": { categories: { quick: { models: ["google/fast"] } } } } },
    _migrations: { "model-chains": true }
  });
  await expect(readFile(metadata)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await prepareOpenCode()).toEqual({});
  expect(await readFile(fx.omo, "utf8")).toBe(source);
});
it("preserves user-owned and edited DIM-named profiles without selecting or rejecting them", async () => {
  const fx = await fixture();
  const original = '{"profiles":{"dim-router":{"model":"user/owned"}}}';
  await writeFile(fx.omo, original, { mode: 0o600 });
  expect(await prepareOpenCode()).toEqual({});
  const metadata = join(fx.home, ".config/dim/opencode-omo-profile.json");
  await mkdir(dirname(metadata), { recursive: true });
  await writeFile(metadata, JSON.stringify({ model: "dim-responses/reviewed" }), { mode: 0o600 });
  expect(await prepareOpenCode()).toEqual({});
  expect(await readFile(fx.omo, "utf8")).toBe(original);
  expect(JSON.parse(await readFile(metadata, "utf8"))).toEqual({ model: "dim-responses/reviewed" });
});
it("does not follow a symlink when reading ownership evidence", async () => {
  const fx = await fixture();
  const metadata = join(fx.home, ".config/dim/opencode-omo-profile.json");
  await mkdir(dirname(metadata), { recursive: true });
  await symlink(fx.connection, metadata);
  await expect(prepareOpenCode()).rejects.toMatchObject({ code: "ELOOP" });
});
it("does not follow or modify OMO inventory owned by the catalog bootstrap", async () => {
  const fx = await fixture();
  const inventory = join(fx.home, ".cache/oh-my-opencode");
  const authentication = join(fx.home, "authentication.json");
  await mkdir(inventory, { recursive: true });
  await writeFile(authentication, '{"preserve":true}', { mode: 0o600 });
  await symlink(authentication, join(inventory, "connected-providers.json"));

  await expect(prepareOpenCode()).resolves.toEqual({});
  expect(await readFile(join(inventory, "connected-providers.json"), "utf8")).toBe('{"preserve":true}');

  expect(await readFile(authentication, "utf8")).toBe('{"preserve":true}');
});

const tierTargets = { quick: "auto:dim-quick", standard: "auto:dim-standard", deep: "auto:dim-deep" };
async function tierFixture() {
  const fx = await fixture(tierTargets);
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ models:
    Object.values(tierTargets).map((id) => ({ id, name: id, api: "chat", context: 10000, output: 1000 })) })));
  return fx;
}
it("selects only the owned opt-in OMO tier profile and preserves root settings and launch permissions", async () => {
  const fx = await tierFixture();
  const original = { agents: { oracle: { models: ["openai/user"], prompt: "keep" } },
    profiles: { personal: { "[opencode]": { model: "user/model" } } } };
  await writeFile(fx.omo, '// user comment\n'+JSON.stringify(original), { mode: 0o600 });
  vi.stubEnv("OMO_PROFILE", "personal");
  expect(await prepareOpenCode()).toEqual({ OMO_PROFILE: "dim-tiers" });
  const text = await readFile(fx.omo, "utf8"), next = parse(text);
  expect(text).toContain('// user comment');
  expect(next.agents).toEqual(original.agents);
  expect(next.profiles.personal).toEqual(original.profiles.personal);
  expect(next.profiles['dim-tiers']['[opencode]']).toMatchObject({ runtime_fallback: false,
    agents: { sisyphus: { models: ['dim-chat/standard'] }, explore: { models: ['dim-chat/quick'] },
      librarian: { models: ['dim-chat/quick'] }, hephaestus: { models: ['dim-chat/deep'] }, oracle: { models: ['dim-chat/deep'] } },
    categories: { quick: { models: ['dim-chat/quick'] }, deep: { models: ['dim-chat/deep'] } } });
  expect(process.env.OPENCODE_CONFIG_CONTENT).toBe('{"permission":{"bash":"ask"},"model":"explicit/original"}');
  expect(process.env.OMO_PROFILE).toBe('personal'); // returned overrides belong to the launcher caller
  expect(await prepareOpenCode()).toEqual({ OMO_PROFILE: 'dim-tiers' });
  expect(await readFile(fx.omo, 'utf8')).toBe(text);
});
it("refuses a user tier profile or edited owned profile without changing it", async () => {
  const fx = await tierFixture();
  const text = '{"profiles":{"dim-tiers":{"model":"user/model"}}}';
  await writeFile(fx.omo,text,{mode:0o600});
  await expect(prepareOpenCode()).rejects.toThrow(/user-owned/);
  expect(await readFile(fx.omo,'utf8')).toBe(text);
  await writeFile(fx.omo,'{}',{mode:0o600});
  await prepareOpenCode();
  const edited = parse(await readFile(fx.omo,'utf8'));edited.profiles['dim-tiers']['[opencode]'].runtime_fallback=true;
  const changed=JSON.stringify(edited);await writeFile(fx.omo,changed,{mode:0o600});
  await expect(prepareOpenCode()).rejects.toThrow(/ownership/);
  expect(await readFile(fx.omo,'utf8')).toBe(changed);
});

it("preserves the official JSON-only OMO configuration instead of shadowing it with a new JSONC file", async () => {
  const fx = await tierFixture(), json = fx.omo.slice(0,-1);
  const original = { agents: { oracle: { prompt: "keep JSON user config" } }, profiles: { personal: { model: "user/model" } } };
  await writeFile(json,JSON.stringify(original),{mode:0o600});
  expect(await prepareOpenCode()).toEqual({ OMO_PROFILE: "dim-tiers" });
  await expect(readFile(fx.omo)).rejects.toMatchObject({ code: "ENOENT" });
  const selected = JSON.parse(await readFile(json,"utf8"));
  expect(selected.agents).toEqual(original.agents);
  expect(selected.profiles.personal).toEqual(original.profiles.personal);
  expect(selected.profiles['dim-tiers']).toBeDefined();
  expect(await prepareOpenCode()).toEqual({ OMO_PROFILE: "dim-tiers" });
  await expect(readFile(fx.omo)).rejects.toMatchObject({ code: "ENOENT" });
});
