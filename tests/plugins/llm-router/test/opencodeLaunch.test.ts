import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "jsonc-parser";
import { prepareOpenCode } from "../../../../plugin-host-llm-router/src/opencode-launch.js";
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
it("adds an isolated OMO routing profile while preserving commented user configuration and permission policy", async () => {
  const fx = await fixture();
  const original = `{
  // retain this user explanation
  "agents": {"custom-reviewer":{"model":"user/choice","prompt":"preserve"}},
  "[opencode]": {"team_mode":{"enabled":true}, "categories":{"custom-category":{"model":"paid/original","description":"keep"}}},
  "profiles":{"personal":{"[opencode]":{"agents":{"sisyphus":{"model":"personal/model"}}}}},
}`;
  await writeFile(fx.omo, original, { mode: 0o600 });
  const environment = await prepareOpenCode();
  expect(environment.OMO_PROFILE).toBe("dim-router");
  expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: { bash: "ask" }, model: "dim-responses/reviewed", small_model: "dim-responses/reviewed" });
  const source = await readFile(fx.omo, "utf8"); expect(source).toContain("// retain this user explanation");
  const configured: unknown = parse(source);
  expect(configured).toMatchObject({ agents: { "custom-reviewer": { model: "user/choice", prompt: "preserve" } },
    profiles: { personal: { "[opencode]": { agents: { sisyphus: { model: "personal/model" } } } },
      "dim-router": { "[opencode]": { runtime_fallback: false,
        agents: { "custom-reviewer": { models: ["dim-responses/reviewed"] }, sisyphus: { models: ["dim-responses/reviewed"] } },
        categories: { quick: { models: ["dim-responses/reviewed"] }, "custom-category": { models: ["dim-responses/reviewed"] } } } } } });
  expect(await prepareOpenCode()).toEqual(environment);
  expect(await readFile(fx.omo, "utf8")).toBe(source);
  // OMO may add its own migration metadata outside the reserved profile. Its
  // current canonical models chains already match our output and stay owned.
  const migrated = source.replace("{", '{"_migrations":{"model-chains":true},');
  await writeFile(fx.omo, migrated);
  expect(await prepareOpenCode()).toEqual(environment);
  expect(await readFile(fx.omo, "utf8")).toBe(migrated);
  vi.stubEnv("DIM_LLM_ROUTER_OPENCODE_MODE", "providers");
  expect(await prepareOpenCode()).toEqual({}); expect(await readFile(fx.omo, "utf8")).toBe(migrated);
});
it("refuses conflicting user-owned profiles and repairs an interrupted generated profile publication", async () => {
  const fx = await fixture();
  await writeFile(fx.omo, '{"profiles":{"dim-router":{"model":"user/owned"}}}', { mode: 0o600 });
  await expect(prepareOpenCode()).rejects.toThrow(/not DIM-owned/);
  expect(await readFile(fx.omo, "utf8")).toContain("user/owned");
  await writeFile(fx.omo, "{}"); await prepareOpenCode();
  await rm(join(fx.home, ".config/dim/opencode-omo-profile.json"));
  await expect(prepareOpenCode()).resolves.toMatchObject({ OMO_PROFILE: "dim-router" });
  await writeFile(fx.omo, '{"profiles":{"dim-router":{"model":"edited"}}}');
  await expect(prepareOpenCode()).rejects.toThrow(/edited/);
});
