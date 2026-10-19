import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import type { WorkspaceHostPluginContext } from "@slop-lab/dim-core/workspace";
import { tryAcquireKernelGuard } from "@slop-lab/dim-core";
import { backendProfile, defaultLimits, integer, loadConfig, origin, parseConfig, parsePolicy, privateFile, text } from "./config.js";
import { RouterLedger, type Usage } from "./ledger.js";
import { createRouter } from "./server.js";
import { exportCapture, removeCapture } from "./archive.js";
import { accountHealth, backupRouter, effectivePolicy, restoreRouter } from "./operator.js";

const usage = `dim llm prepare DIRECTORY --backend ORIGIN --backend-key-file FILE --exclusive-account-reference NAME --model ID --context-tokens N --output-tokens N
  dim llm serve|health|projects|principals|active CONFIG
  dim llm project-add|project-policy|policy|pause|resume|disable|enable|usage PROJECT --config CONFIG [--route ID] [--policy-file FILE]
  dim llm attach WORKSPACE --config CONFIG --project PROJECT --endpoint ORIGIN [--route ID] [--principal ID]
  dim llm principal-revoke PRINCIPAL --config CONFIG
  dim llm cancel|resolve|capture|capture-delete REQUEST --config CONFIG [--output DIRECTORY] [--usage-file FILE]
  dim llm retention PROJECT --config CONFIG --before UTC_TIMESTAMP
  dim llm usage-export PROJECT --config CONFIG --output FILE
  dim llm backup CONFIG --output DIRECTORY
  dim llm restore BACKUP_DIRECTORY --output NEW_DIRECTORY`;
export async function runLlmCommand(args: string[], context: WorkspaceHostPluginContext): Promise<void> {
  const [command, action, positional, ...tail] = args;
  if (command !== "llm" || !action || !positional || positional.startsWith("-")) throw new Error(usage);
  const flags = new Map<string, string>();
  const allowed = new Set(["--backend", "--backend-key-file", "--exclusive-account-reference", "--backend-auth-directory", "--model", "--context-tokens", "--output-tokens", "--api", "--listen-host", "--port", "--config", "--endpoint", "--route", "--project", "--principal", "--policy-file", "--output", "--before", "--usage-file", "--backend-state-quiesced"]);
  for (let index = 0; index < tail.length; index += 2) {
    const key = tail[index], value = tail[index + 1]; if (!key || !allowed.has(key) || !value || flags.has(key)) throw new Error(usage); flags.set(key, value);
  }
  const required = (name: string) => { const value = flags.get(name); if (value === undefined) throw new Error(`required ${name}\n${usage}`); return value; };
  if (action === "prepare") {
    const directory = resolve(positional), api = flags.get("--api") ?? "responses";
    const config = parseConfig({ schemaVersion: 2, stateDirectory: join(directory, "state"), workspaceStateRoot: context.stateRoot,
      listen: { host: flags.get("--listen-host") ?? "127.0.0.1", port: Number(flags.get("--port") ?? 8318) }, backend: backendProfile,
      accounts: [{ id: "default", reference: required("--exclusive-account-reference"), endpoint: required("--backend"), keyFile: resolve(required("--backend-key-file")),
        ...(flags.has("--backend-auth-directory") ? { credentialDirectory: resolve(required("--backend-auth-directory")) } : {}) }],
      routes: [{ id: "default", accountId: "default", models: [{ id: required("--model"), name: required("--model"), api,
        context: integer(Number(required("--context-tokens"))), output: integer(Number(required("--output-tokens"))) }] }], limits: defaultLimits });
    await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, "router.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`Prepared ${join(directory, "router.json")}. Review the exclusive backend/account contract, create a project, then serve.`); return;
  }
  if (action === "restore") { console.log(await restoreRouter(resolve(positional), resolve(required("--output")), context.store.root)); return; }
  const configActions = new Set(["serve", "health", "projects", "principals", "active", "backup"]);
  const config = await loadConfig(resolve(configActions.has(action) ? positional : required("--config")));
  if (config.workspaceStateRoot !== context.store.root) throw new Error("router and selected host must use the same workspace state root");
  if (action === "serve") {
    const router = await createRouter(config);
    try { context.signal.throwIfAborted(); router.server.listen(config.listen); await once(router.server, "listening", { signal: context.signal });
      console.log("DIM project LLM router listening; upstream login/refresh remains CLIProxyAPI-owned");
      await new Promise<void>((resolve) => { if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", () => resolve(), { once: true }); });
    } finally { await router.close(); } return;
  }
  const ledger = new RouterLedger(config.stateDirectory), guard = await tryAcquireKernelGuard(join(config.stateDirectory, "operator.guard"));
  if (!guard) { ledger.close(); throw new Error("another router operator command is running; retry after it finishes"); }
  try {
    if (action === "health") { const health = await accountHealth(config); ledger.audit("operator", "account.health", "accounts", health); console.log(JSON.stringify(health, null, 2)); return; }
    if (action === "backup") { await backupRouter(config, resolve(required("--output")), { backendStateQuiesced: flags.get("--backend-state-quiesced") === "yes" }); console.log("Private consistent backup written; inspect its backendCredentials coverage before relying on it"); return; }
    if (action === "projects") { console.log(JSON.stringify(ledger.projects(), null, 2)); return; }
    if (action === "principals") { console.log(JSON.stringify(ledger.database.prepare("SELECT id,project_id,workspace_id,workspace_name,route_id,enabled FROM principals ORDER BY id").all(), null, 2)); return; }
    if (action === "active") { console.log(JSON.stringify(ledger.database.prepare("SELECT id,project_id,principal_id,account_id,started_at,execution,delivery,accounting,occupied,cancel_requested FROM requests WHERE occupied=1 OR outcome='running' ORDER BY started_at LIMIT 1000").all(), null, 2)); return; }
    if (action === "project-add" || action === "project-policy") {
      const policy = flags.has("--policy-file") ? parsePolicy(JSON.parse(await privateFile(resolve(required("--policy-file")))))
        : parsePolicy({ allowedRoutes: [flags.get("--route") ?? "default"], limits: config.limits, captureMode: "required", tokenMode: "observe" });
      if (policy.allowedRoutes.some((id) => !config.routes.some((route) => route.id === id))) throw new Error("policy refers to an unknown route");
      if (action === "project-add") ledger.createProject(positional, policy); else ledger.updatePolicy(positional, policy);
      console.log(JSON.stringify(effectivePolicy(config, ledger, positional), null, 2)); return;
    }
    if (["pause", "resume", "disable", "enable"].includes(action)) { ledger.setProject(positional, action === "pause" ? "pause" : action === "resume" ? "resume" : action === "disable" ? "disable" : "enable"); return; }
    if (action === "policy") { console.log(JSON.stringify(effectivePolicy(config, ledger, positional), null, 2)); return; }
    if (action === "usage") { console.log(JSON.stringify(ledger.usage(positional, config.limits), null, 2)); return; }
    if (action === "principal-revoke") { ledger.revoke(positional); return; }
    if (action === "cancel") { ledger.cancel(positional); console.log(JSON.stringify({ cancellationRequested: true, upstreamTerminationConfirmed: false })); return; }
    if (action === "resolve") {
      let usage: Usage | undefined;
      if (flags.has("--usage-file")) { const raw: unknown = JSON.parse(await privateFile(resolve(required("--usage-file"))));
        const row = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
        if (!row || !("inputTokens" in row) || !("outputTokens" in row) || typeof row.inputTokens !== "number" || typeof row.outputTokens !== "number"
          || !Number.isSafeInteger(row.inputTokens) || !Number.isSafeInteger(row.outputTokens) || row.inputTokens < 0 || row.outputTokens < 0) throw new Error("resolution usage requires nonnegative inputTokens/outputTokens");
        usage = { inputTokens: row.inputTokens, outputTokens: row.outputTokens, raw, source: "operator-resolution" };
      }
      ledger.resolve(positional, usage); return;
    }
    if (action === "capture") { await exportCapture(ledger, positional, resolve(required("--output"))); return; }
    if (action === "capture-delete") { await removeCapture(ledger, positional, "deleted"); return; }
    if (action === "retention") {
      ledger.project(positional); const before = Date.parse(required("--before")); if (!Number.isFinite(before) || !required("--before").endsWith("Z")) throw new Error("retention requires an explicit UTC timestamp ending Z");
      let removed = 0;
      while (true) { context.signal.throwIfAborted(); const rows = ledger.database.prepare("SELECT id FROM requests WHERE project_id=? AND outcome!='running' AND finished_at<? AND capture_state NOT IN ('expired','deleted','disabled_by_policy') ORDER BY finished_at LIMIT 100").all(positional, before);
        if (!rows.length) break; for (const row of rows) { await removeCapture(ledger, text(row.id), "expired"); removed++; } }
      console.log(JSON.stringify({ expired: removed, backups: "existing backups retain data until the operator expires those backups separately" })); return;
    }
    if (action === "usage-export") {
      ledger.project(positional); const file = await open(resolve(required("--output")), "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ kind: "summary", ...ledger.usage(positional, config.limits) }) + "\n"); let cursor = 0;
        while (true) { context.signal.throwIfAborted(); const rows = ledger.database.prepare("SELECT rowid AS cursor,* FROM requests WHERE project_id=? AND rowid>? ORDER BY rowid LIMIT 100").all(positional, cursor);
          if (!rows.length) break; for (const row of rows) { await file.writeFile(JSON.stringify({ kind: "request", ...row }) + "\n"); cursor = Number(row.cursor); } } await file.sync();
      } finally { await file.close(); } ledger.audit("operator", "usage.export", positional); return;
    }
    if (action !== "attach") throw new Error(usage);
    const workspace = await context.store.read(positional), projectId = required("--project");
    const route = config.routes.find((route) => route.id === (flags.get("--route") ?? "default")); if (!route) throw new Error("router route was not found");
    const selectedModel = route.models.find(({ id }) => id === (flags.get("--model") ?? route.models[0]?.id));
    if (!selectedModel) throw new Error("attachment default model must belong to the selected route");
    const principalId = flags.get("--principal") ?? workspace.id;
    const connection = { schemaVersion: 1, workspaceId: workspace.id, projectId, principalId, endpoint: origin(required("--endpoint")), token: ledger.issue(workspace, route.id, projectId, principalId), models: route.models, defaultModel: selectedModel.id };
    const adapter = await readFile(new URL("./opencode.js", import.meta.url), "utf8");
    const launch = await readFile(new URL("./opencode-launch.js", import.meta.url), "utf8");
    const status = await context.service.exec(workspace.name, ["node", "--input-type=commonjs", "-e", attachScript], { signal: context.signal, workspaceId: workspace.id, stdin: Readable.from(JSON.stringify({ connection, adapter, launch })) });
    if (status !== 0) { ledger.revoke(principalId); throw new Error("workspace LLM attachment failed; principal revoked"); }
    console.log(`Attached project '${projectId}' route '${route.id}' to ${workspace.name}; OpenCode defaults to dim-${selectedModel.api}/${selectedModel.id}. Rerun dim tools server to refresh an existing server.`);
  } finally { ledger.close(); await guard.release(); }
}
const attachScript = String.raw`
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");let input="";
process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{
 const data=JSON.parse(input),home=os.homedir(),config=path.join(home,".config/dim"),plugins=path.join(process.env.XDG_CONFIG_HOME||path.join(home,".config"),"opencode/plugins");
 fs.mkdirSync(config,{recursive:true,mode:0o700});fs.mkdirSync(plugins,{recursive:true,mode:0o700});
 for(const [file,value] of [[path.join(config,"llm-router.json"),JSON.stringify(data.connection)], [path.join(plugins,"dim-llm-router.js"),data.adapter], [path.join(config,"opencode-launch.js"),data.launch]]){
  try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||st.nlink!==1)throw Error("unsafe workspace config path");}catch(error){if(error.code!=="ENOENT")throw error;}
  const temporary=file+".tmp-"+require("node:crypto").randomUUID();fs.writeFileSync(temporary,value,{mode:0o600,flag:"wx"});fs.renameSync(temporary,file);
 }
});`;
