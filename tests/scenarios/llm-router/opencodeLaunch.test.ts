import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "jsonc-parser";
import { prepareOpenCode } from "../../../packages/host/plugins/llm-router/src/opencode-launch.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "dim-opencode-profile-")); roots.push(home);
  vi.stubEnv("HOME", home); vi.stubEnv("DIM_LLM_ROUTER_OPENCODE_MODE", "router");
  vi.stubEnv("OPENCODE_CONFIG_CONTENT", '{"permission":{"bash":"ask"},"model":"explicit/original"}');
  const connection = join(home, "connection.json"); vi.stubEnv("DIM_LLM_ROUTER_CONNECTION_FILE", connection);
  await writeFile(connection, JSON.stringify({ schemaVersion: 1, defaultModel: "reviewed", models: [{ id: "reviewed", api: "responses" }] }), { mode: 0o600 });
  await mkdir(join(home, ".omo")); await mkdir(join(home, ".local/lib/node_modules"), { recursive: true });
  const require = createRequire(import.meta.url);
  await symlink(dirname(require.resolve("jsonc-parser/package.json")), join(home, ".local/lib/node_modules/jsonc-parser"));
  return { home, connection, omo: join(home, ".omo/omo.jsonc") };
}
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
