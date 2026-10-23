// @ts-check
import { createInterface } from "node:readline";
import { posix } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { createContext, runInContext, SourceTextModule, SyntheticModule } from "node:vm";

/** @type {Map<number, { resolve: (value: string | undefined) => void, reject: (reason: Error) => void }>} */
const requests = new Map();
let sequence = 0;
/** @type {(value: {entrypoint: string, changes: readonly unknown[]}) => void} */
let initialize;
const initial = new Promise((resolve) => { initialize = resolve; });
let started = false;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (!started) {
      if (message.type !== "init" || typeof message.entrypoint !== "string" || !Array.isArray(message.changes)) throw Error("invalid initialization");
      started = true;
      initialize(message);
      return;
    }
    if (message.type !== "read-result" || !Number.isSafeInteger(message.id) || (message.content !== null && typeof message.content !== "string")) throw Error("invalid read response");
    const pending = requests.get(message.id);
    if (pending === undefined) throw Error("unknown read response");
    requests.delete(message.id);
    pending.resolve(message.content === null ? undefined : message.content);
  } catch (error) { fail(error); }
});
lines.on("close", () => {
  for (const pending of requests.values()) pending.reject(Error("read broker disconnected"));
  requests.clear();
});
/** @param {unknown} error */
function fail(error) {
  process.stderr.write(String(error instanceof Error ? error.stack : error).slice(0, 4096));
  process.exitCode = 1;
  lines.close();
  process.stdin.destroy();
}
/** @param {string} path @param {'dependency'|'target'} role @param {'before'|'after'} [view] */
function read(path, role, view = "after") {
  if (typeof path !== "string" || (view !== "before" && view !== "after")) return Promise.reject(Error("invalid read request"));
  const id = ++sequence;
  /** @type {Promise<string | undefined>} */
  const result = new Promise((resolve, reject) => requests.set(id, { resolve, reject }));
  process.stdout.write(JSON.stringify({ type: "read", id, path, role, view }) + "\n");
  return result;
}

try {
  const input = await initial;
  const context = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  // Export context-native functions and promises, never host functions/objects.
  // Docker remains the containment boundary; this also prevents trivial foreign
  // Function constructors through the convenience API or JSON import objects.
  context.__readBridge = (/** @type {string} */ path, /** @type {'dependency'|'target'} */ role, /** @type {'before'|'after'} */ view, /** @type {(error: string | null, value?: string) => void} */ callback) => {
    if (typeof callback !== "function") return;
    read(path, role, view).then((value) => callback(null, value), (error) => callback(String(error)));
  };
  const methods = runInContext(`((send) => ({
    readText: (path) => new Promise((resolve, reject) => send(path, 'dependency', 'after', (error, value) => error === null ? resolve(value) : reject(new Error(error)))),
    readTarget: (path, view = 'after') => new Promise((resolve, reject) => send(path, 'target', view, (error, value) => error === null ? resolve(value) : reject(new Error(error))))
  }))(__readBridge)`, context);
  delete context.__readBridge;
  /** @type {Map<string, Promise<import('node:vm').Module>>} */
  const modules = new Map();
  const api = new SyntheticModule(["readText", "readTarget"], function () {
    this.setExport("readText", methods.readText);
    this.setExport("readTarget", methods.readTarget);
  }, { context, identifier: "dim:review" });
  /** @param {string} path @returns {Promise<import('node:vm').Module>} */
  function load(path) {
    const existing = modules.get(path);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      const source = await read(path, "dependency");
      if (source === undefined) throw Error(`review module is missing: ${path}`);
      if (path.endsWith(".json")) {
        const value = runInContext(`JSON.parse(${JSON.stringify(source)})`, context);
        return new SyntheticModule(["default"], function () { this.setExport("default", value); }, { context, identifier: path });
      }
      // Keep broker reads and digests on the original repository bytes. Only
      // the guest's module evaluation sees stripped, erasable TypeScript.
      const executable = path.endsWith(".ts") || path.endsWith(".mts")
        ? stripTypeScriptTypes(source, { mode: "strip", sourceUrl: `dim-repository:/${path}` })
        : source;
      return new SourceTextModule(executable, {
        context, identifier: path,
        initializeImportMeta(meta) { meta.url = `dim-repository:/${path}`; },
        async importModuleDynamically(specifier, reference) {
          const module = await resolve(specifier, reference);
          if (module.status === "unlinked") await module.link(resolve);
          if (module.status === "linked") await module.evaluate({ timeout: 1000 });
          return module;
        }
      });
    })();
    modules.set(path, pending);
    return pending;
  }
  /** @param {string} specifier @param {import('node:vm').Module} reference */
  async function resolve(specifier, reference) {
    if (specifier === "dim:review") return api;
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) throw Error(`unsupported review import: ${specifier}`);
    const path = posix.normalize(posix.join(posix.dirname(reference.identifier), specifier));
    if (path === ".." || path.startsWith("../") || path.startsWith("/") || path.includes("\\") || path.includes("\0")) throw Error("review import escapes repository");
    return load(path);
  }
  const entrypoint = await load(input.entrypoint);
  await entrypoint.link(resolve);
  await entrypoint.evaluate({ timeout: 1000 });
  const matches = /** @type {Record<string, unknown>} */ (entrypoint.namespace).matches;
  if (typeof matches !== "function") throw Error("review module must export matches(changes)");
  const changes = runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(input.changes))})`, context);
  const result = await matches(changes);
  if (typeof result !== "boolean" || requests.size !== 0) throw Error("review detector must finish with one boolean and no pending reads");
  process.stdout.write(JSON.stringify({ type: "result", matches: result }) + "\n");
  lines.close();
  process.stdin.destroy();
} catch (error) { fail(error); }
