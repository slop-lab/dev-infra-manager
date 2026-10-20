import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ControlPlanePlugin } from "../../packages/control-plane/core/src/plugin.js";
import type { startControlPlanePlugins } from "../../packages/control-plane/core/src/index.js";
import { loadExampleRecipe, resolveExamplePath } from "./recipe.ts";
import { loopbackServiceConfiguration } from "./separated-service-config.ts";
const data = process.env.DIM_DATA_HOME, setup = process.argv[2];
if (!data || !setup?.startsWith("/")) throw new Error("private DIM_DATA_HOME and absolute operator directory required");
const resolver = createRequire(join(data, "control-plane/runtime/current/package.json"));
try { resolver.resolve("@slop-lab/dim-host-core"); throw new Error("control-plane runtime contains host core"); }
catch (error) { if (!(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")) throw error; }
async function load<T>(name: string): Promise<T> { return import(pathToFileURL(resolver.resolve(name)).href) as Promise<T>; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid private service configuration"); return Object.fromEntries(Object.entries(value)); }
const read = async (file: string) => object(JSON.parse(await readFile(join(setup, file), "utf8")));
const native = await read("native-git.json"), ordinary = await read("ordinary-ci.json"), runtime = await read("acceptance-runtime.json");
const { humanReviewers, hostPromoters, ci, ...repository } = native;
const placed = loopbackServiceConfiguration(ci, ordinary);
repository.gitVersion = execFileSync("/usr/bin/git", ["--version"], { encoding: "utf8" }).trim().replace(/^git version /, "");
const state = join(data, "acceptance-services"); await mkdir(state, { mode: 0o700 });
const configurations: Readonly<Record<string, unknown>> = {
  "git-repositories": { service: repository, stateDirectory: join(state, "git"), ...object(runtime.native), expectedGenerationId: runtime.generationId, listen: { host: "127.0.0.1", port: 8080 } },
  "code-review": { humanReviewers }, "merge-policy": { hostPromoters }, "git-ci": placed.gitCi, "ci-workflows": {},
  ci: { service: placed.coordinator, stateDirectory: join(state, "ci"), ...object(runtime.ci), expectedGenerationId: runtime.generationId, listen: { host: "127.0.0.1", port: 8081 } }
};
const examples = resolve(import.meta.dirname, "../../examples"), catalog: unknown = JSON.parse(await readFile(join(examples, "catalog.json"), "utf8"));
if (!Array.isArray(catalog) || !catalog.every((entry): entry is string => typeof entry === "string")) throw new Error("invalid example catalog");
const recipes = await Promise.all(catalog.map((path) => loadExampleRecipe(resolveExamplePath({ directory: examples }, path))));
const selected = new Set(recipes.filter(({ commands }) => commands["verify-vm"]).flatMap(({ plugins }) => plugins.controlPlane.map((spec) => spec.slice(0, spec.lastIndexOf("@")))));
const entries = [];
for (const name of selected) {
  const shortName = name.replace("@slop-lab/dim-control-plane-plugin-", "");
  if (!(shortName in configurations)) throw new Error(`no acceptance configuration for declared plugin ${name}`);
  const { controlPlanePlugin } = await load<{ controlPlanePlugin: ControlPlanePlugin }>(name);
  entries.push({ plugin: controlPlanePlugin, config: configurations[shortName] });
}
const core = await load<{ startControlPlanePlugins: typeof startControlPlanePlugins }>("@slop-lab/dim-control-plane-core");
const controller = new AbortController();
const running = await core.startControlPlanePlugins(entries, controller.signal);
try {
  for (const [port, role] of [[8080, "native"], [8081, "ci"]] as const) {
    const credentials = object(runtime[role]);
    const response = await fetch(`http://127.0.0.1:${port}/v1/activation`, { method: "POST", headers: {
      authorization: `Bearer ${String(credentials.activationToken)}`, "content-type": "application/json"
    }, body: JSON.stringify({ schemaVersion: 1, generationId: runtime.generationId }), signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) throw new Error(`control-plane ${role} activation failed`);
  }
  console.log("separate-control-plane-ready: installed repository plugins and CI coordinator active; no host core");
  await new Promise<void>((done) => { process.once("SIGINT", done); process.once("SIGTERM", done); });
} finally { controller.abort(); await running.close(); }
