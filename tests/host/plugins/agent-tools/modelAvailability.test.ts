import { readFile, mkdtemp, mkdir, writeFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { expect, it } from "vitest";
import { patchOmoModelAvailability, patchInstalledOmo, refreshOmoModelCatalog } from "../../../../packages/host/plugins/agent-tools/src/assets/omo-model-availability.mjs";

const upstream = await readFile(new URL("./fixtures/omo-4.19.4-functions.txt", import.meta.url), "utf8");
const chain = [
  { providers: ["opencode", "moonshotai"], model: "kimi-k3", variant: "max" },
  { providers: ["opencode", "openai"], model: "gpt-5.6-sol", variant: "high" },
];
function fixture(cache: unknown) {
  const logs: unknown[] = [];
  const context = createContext({
    readProviderModelsCache: () => cache,
    readConnectedProvidersCache: () => ["opencode", "openai"],
    transformModelForProvider: (_provider: string, model: string) => model,
    canonicalizeModelID: (model: string) => model,
    log2: (...args: unknown[]) => logs.push(args),
    selectFallbackProvider: (providers: string[]) => providers[0],
    createReachabilityChecker: () => () => true,
  });
  runInContext(patchOmoModelAvailability(upstream), context);
  return { context, logs };
}
const catalog = { connected: ["opencode", "openai"], models: { opencode: [{ id: "free-model" }], openai: [{ id: "gpt-5.6-sol" }] } };
it("chooses an existing model for initial agents and session retry without changing role variants", () => {
  const { context } = fixture(catalog);
  context.requirement = { fallbackChain: chain };
  expect(runInContext("getFirstFallbackModel(requirement)", context)).toEqual({ model: "openai/gpt-5.6-sol", provenance: "provider-fallback", variant: "high" });
  context.state = { fallbackChain: chain, attemptCount: 0, providerID: "openai", modelID: "old-model" };
  expect(runInContext('getNextReachableFallback("session", state)', context)).toMatchObject({ providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" });
  expect(chain[0]?.providers).toEqual(["opencode", "moonshotai"]);
});
it("never guesses model availability from a connected provider or an unknown catalog", () => {
  for (const cache of [undefined, { connected: ["opencode"], models: { opencode: [] } }]) {
    const { context } = fixture(cache);
    context.requirement = { fallbackChain: chain };
    expect(runInContext("getFirstFallbackModel(requirement)", context)).toBeUndefined();
  }
});
it("background retries skip missing models and select the provider that actually offers the next model", async () => {
  const { context } = fixture(catalog);
  const selected: unknown[] = [];
  context.defaultFallbackRetryHandlerDeps = {
    log: () => {}, readProviderModelsCache: () => catalog, readConnectedProvidersCache: () => catalog.connected,
    shouldRetryError: () => true, hasMoreFallbacks: () => true,
    getNextFallback: (entries: unknown[], index: number) => entries[index],
    selectFallbackProvider: (providers: string[]) => providers[0],
    transformModelForProvider: (_provider: string, model: string) => model,
    isProviderExhaustionFallbackEligible: () => false,
  };
  context.canonicalizeModelID2 = (value: string) => value;
  context.ensureCurrentAttempt = () => ({ attemptId: "attempt" });
  context.scheduleRetryAttempt = (_task: unknown, _id: unknown, model: unknown) => { selected.push(model); throw new Error("selected candidate"); };
  context.args = {
    task: { id: "task", model: { providerID: "openai", modelID: "old" }, fallbackChain: chain, currentAttemptID: "attempt" },
    errorInfo: { name: "ModelNotFoundError", message: "Model not found" }, idleDeferralTimers: new Map(),
  };
  await expect(runInContext("tryFallbackRetry(args)", context)).rejects.toThrow("selected candidate");
  expect(selected).toEqual([{ providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" }]);
});
it("the pinned patch is idempotent and rejects changed source or package versions", async () => {
  const patched = patchOmoModelAvailability(upstream);
  expect(patchOmoModelAvailability(patched)).toBe(patched);
  expect(() => patchOmoModelAvailability(upstream.replace("const candidate = deps.getNextFallback", "const changed = deps.getNextFallback"))).toThrow("source changed");
  const root = await mkdtemp(join(tmpdir(), "dim-omo-pin-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "oh-my-openagent", version: "4.19.5" }));
    expect(() => patchInstalledOmo(root)).toThrow("requires oh-my-openagent 4.19.4");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("refreshes a fresh catalog using OpenCode with its configured provider integrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-omo-catalog-"));
  try {
    const executable = join(root, "opencode");
    const listing = 'opencode/free-model\n{\n  "id": "free-model", "variants": {"low":{}}\n}\nopenai/gpt-5.6-sol\n{\n  "id": "gpt-5.6-sol"\n}\n';
    await writeFile(executable, `#!/bin/sh\n[ "$1 $2" = "models --verbose" ] || exit 7\ncat <<'MODELS'\n${listing}MODELS\n`, { mode: 0o700 });
    refreshOmoModelCatalog(executable, root);
    const value = JSON.parse(await readFile(join(root, "oh-my-opencode/provider-models.json"), "utf8"));
    expect(value.models).toEqual({ opencode: [{ id: "free-model", variants: { low: {} } }], openai: [{ id: "gpt-5.6-sol" }] });
    expect(value.connected).toEqual(["opencode", "openai"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("preserves a genuinely available Kimi role instead of replacing it with another family", () => {
  const { context } = fixture({ connected: ["moonshotai"], models: { moonshotai: [{ id: "kimi-k3" }] } });
  context.requirement = { fallbackChain: chain };
  expect(runInContext("getFirstFallbackModel(requirement)", context)).toEqual({ model: "moonshotai/kimi-k3", provenance: "provider-fallback", variant: "max" });
});
it("rejects cache links without replacing their targets and writes private cache files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-omo-cache-safety-"));
  try {
    const executable = join(root, "opencode"), target = join(root, "outside");
    await writeFile(executable, `#!/bin/sh\nprintf 'openai/test\\n{\\n  "id":"test"\\n}\\n'\n`, { mode: 0o700 });
    await mkdir(join(root, "oh-my-opencode"));
    await writeFile(target, "preserved");
    const cache = join(root, "oh-my-opencode/provider-models.json");
    await symlink(target, cache);
    expect(() => refreshOmoModelCatalog(executable, root)).toThrow("owned regular file");
    expect(await readFile(target, "utf8")).toBe("preserved");
    await rm(cache);
    refreshOmoModelCatalog(executable, root);
    expect((await stat(cache)).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
