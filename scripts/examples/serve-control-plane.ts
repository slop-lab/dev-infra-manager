import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ControlPlanePlugin } from "../../packages/control-plane/core/src/plugin-api.js";
import type { startControlPlanePlugins } from "../../packages/control-plane/core/src/index.js";
import { separatedControlPlanePackages } from "./separated-recipes.ts";
import { separatedControlPlaneConfigurations, selectedSeparatedControlPlaneConfigurations } from "./separated-control-plane-composition.ts";
const data = process.env.DIM_DATA_HOME, setup = process.argv[2];
if (!data || !setup?.startsWith("/")) throw new Error("private DIM_DATA_HOME and absolute operator directory required");
const resolver = createRequire(join(data, "control-plane/runtime/current/package.json"));
try { resolver.resolve("@slop-lab/dim-host-core"); throw new Error("control-plane runtime contains host core"); }
catch (error) { if (!(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")) throw error; }
async function load<T>(name: string): Promise<T> { return import(pathToFileURL(resolver.resolve(name)).href) as Promise<T>; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid private service configuration"); return Object.fromEntries(Object.entries(value)); }
const read = async (file: string) => object(JSON.parse(await readFile(join(setup, file), "utf8")));
const native = await read("native-git.json"), ordinary = await read("execution.json"), runtime = await read("acceptance-runtime.json");
native.gitVersion = execFileSync("/usr/bin/git", ["--version"], { encoding: "utf8" }).trim().replace(/^git version /, "");
const state = join(data, "acceptance-services"); await mkdir(state, { mode: 0o700 });
const configurations = separatedControlPlaneConfigurations(native, ordinary, runtime, state);
const selected = await separatedControlPlanePackages(resolve(import.meta.dirname, "../../examples"));
const entries = [];
for (const [name, config] of selectedSeparatedControlPlaneConfigurations(configurations, selected)) {
  const { controlPlanePlugin } = await load<{ controlPlanePlugin: ControlPlanePlugin }>(name);
  entries.push({ plugin: controlPlanePlugin, config });
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
