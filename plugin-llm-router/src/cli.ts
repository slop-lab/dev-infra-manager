import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-core/workspace";
import { defaultLimits, integer, loadConfig, origin, parseConfig, type RouterConfig } from "./config.js";
import { RouterLedger } from "./ledger.js";
import { createRouter } from "./server.js";

const usage = "dim llm prepare DIRECTORY --backend ORIGIN --backend-key-file FILE --model ID --context-tokens N --output-tokens N [--api responses|chat] [--listen-host IP] [--port N]\n"
  + "dim llm serve CONFIG\ndim llm attach WORKSPACE --config FILE --endpoint WORKSPACE_REACHABLE_ORIGIN [--route ID]\ndim llm usage|revoke WORKSPACE --config FILE";
export async function runLlmCommand(args: string[], context: WorkspaceHostPluginContext): Promise<void> {
  const [command, action, positional, ...tail] = args;
  if (command !== "llm" || !action || !positional || positional.startsWith("-")) throw new Error(usage);
  const flags = new Map<string, string>();
  const allowed = new Set(["--backend", "--backend-key-file", "--model", "--context-tokens", "--output-tokens", "--api", "--listen-host", "--port", "--config", "--endpoint", "--route"]);
  for (let index = 0; index < tail.length; index += 2) {
    const key = tail[index], value = tail[index + 1];
    if (!key || !allowed.has(key) || !value || flags.has(key)) throw new Error(usage); flags.set(key, value);
  }
  const required = (name: string) => { const value = flags.get(name); if (value === undefined) throw new Error(`required ${name}\n${usage}`); return value; };
  if (action === "prepare") {
    const directory = resolve(positional), api = flags.get("--api") ?? "responses";
    const config = parseConfig({ schemaVersion: 1, stateDirectory: join(directory, "state"), workspaceStateRoot: context.stateRoot,
      listen: { host: flags.get("--listen-host") ?? "127.0.0.1", port: Number(flags.get("--port") ?? 8318) },
      routes: [{ id: "default", endpoint: required("--backend"), keyFile: resolve(required("--backend-key-file")), models: [
        { id: required("--model"), name: required("--model"), api, context: integer(Number(required("--context-tokens"))), output: integer(Number(required("--output-tokens"))) }] }], limits: defaultLimits });
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "router.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`Prepared ${join(directory, "router.json")}. Review it, then run: dim llm serve '${join(directory, "router.json").replaceAll("'", "'\\''")}'`);
    return;
  }
  if (action === "serve") {
    const config = await loadConfig(resolve(positional));
    const router = await createRouter(config);
    try {
      context.signal.throwIfAborted(); router.server.listen(config.listen);
      await once(router.server, "listening", { signal: context.signal });
      console.log("DIM workspace LLM router listening; upstream account login remains host-owned");
      await new Promise<void>((resolve) => { if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", () => resolve(), { once: true }); });
    } finally { await router.close(); }
    return;
  }
  if (!["attach", "usage", "revoke"].includes(action)) throw new Error(usage);
  const config = await loadConfig(resolve(required("--config")));
  if (config.workspaceStateRoot !== context.store.root) throw new Error("router and selected host must use the same workspace state root");
  const workspace = await context.store.read(positional);
  const ledger = new RouterLedger(config.stateDirectory);
  try {
    if (action === "usage") { console.log(JSON.stringify(ledger.usage(workspace.id), null, 2)); return; }
    if (action === "revoke") { ledger.revoke(workspace.id); console.log(`Revoked LLM access for ${workspace.name}`); return; }
    const route = config.routes.find((route) => route.id === (flags.get("--route") ?? "default"));
    if (route === undefined) throw new Error("router route was not found");
    const connection = { schemaVersion: 1, workspaceId: workspace.id, endpoint: origin(required("--endpoint")),
      token: ledger.issue(workspace, route.id), models: route.models };
    // Copy a workspace-only adapter. Host config, provider keys and OAuth files never enter this payload.
    const adapter = await readFile(new URL("./opencode.js", import.meta.url), "utf8");
    const status = await context.service.exec(workspace.name, ["node", "--input-type=commonjs", "-e", attachScript], {
      signal: context.signal, workspaceId: workspace.id, stdin: Readable.from(JSON.stringify({ connection, adapter })) });
    if (status !== 0) { ledger.revoke(workspace.id); throw new Error("workspace LLM attachment failed; access revoked"); }
    console.log(`Attached LLM route '${route.id}' to ${workspace.name}. OpenCode providers: ${[...new Set(route.models.map((model) => `dim-${model.api}`))].join(", ")}`);
  } finally { ledger.close(); }
}
const attachScript = String.raw`
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");let input="";
process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{
 const data=JSON.parse(input),home=os.homedir(),config=path.join(home,".config/dim"),plugins=path.join(home,".config/opencode/plugins");
 fs.mkdirSync(config,{recursive:true,mode:0o700});fs.mkdirSync(plugins,{recursive:true,mode:0o700});
 for(const [file,value] of [[path.join(config,"llm-router.json"),JSON.stringify(data.connection)], [path.join(plugins,"dim-llm-router.js"),data.adapter]]){
  try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||st.nlink!==1)throw Error("unsafe workspace config path");}catch(error){if(error.code!=="ENOENT")throw error;}
  const temporary=file+".tmp-"+require("node:crypto").randomUUID();fs.writeFileSync(temporary,value,{mode:0o600,flag:"wx"});fs.renameSync(temporary,file);
 }
});`;
