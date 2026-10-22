import { mkdir, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { tryAcquireKernelGuard } from "@slop-lab/dim-control-plane-core/lock";
import { backendProfile, defaultLimits, integer, loadConfig, parseConfig, parsePolicy, privateFile, text } from "./config.js";
import { invokeRouterOperation } from "./operations.js";
import { RouterLedger, type Usage } from "./ledger.js";
import { createRouter } from "./server.js";
import { createRouterOperatorServer } from "./operator-server.js";
import { exportCapture, removeCapture } from "./archive.js";
import { backupRouter, effectivePolicy, restoreRouter } from "./operator.js";

const usage = `dim-control-plane-llm-router prepare DIRECTORY --backend ORIGIN --backend-key-file FILE --exclusive-account-reference NAME --model ID --context-tokens N --output-tokens N [--operator-id ID --operator-key-file FILE]
  dim-control-plane-llm-router serve|operator-serve|health|projects|principals|active CONFIG
  dim-control-plane-llm-router project-add|project-policy|policy|pause|resume|disable|enable|usage PROJECT --config CONFIG [--route ID] [--policy-file FILE]
  dim-control-plane-llm-router principal-revoke PRINCIPAL --config CONFIG
  dim-control-plane-llm-router cancel|resolve|capture|capture-delete REQUEST --config CONFIG [--output DIRECTORY] [--usage-file FILE]
  dim-control-plane-llm-router retention PROJECT --config CONFIG --before UTC_TIMESTAMP
  dim-control-plane-llm-router usage-export PROJECT --config CONFIG --output FILE
  dim-control-plane-llm-router backup CONFIG --output DIRECTORY
  dim-control-plane-llm-router restore BACKUP_DIRECTORY --output NEW_DIRECTORY`;
export async function runRouterCommand(args: string[], context: { signal: AbortSignal }): Promise<void> {
  const [command, action, positional, ...tail] = args;
  if (command !== "llm" || !action || !positional || positional.startsWith("-")) throw new Error(usage);
  const flags = new Map<string, string>();
  const allowed = new Set(["--backend", "--backend-key-file", "--exclusive-account-reference", "--backend-auth-directory", "--model", "--context-tokens", "--output-tokens", "--api", "--listen-host", "--port", "--config", "--endpoint", "--route", "--project", "--principal", "--policy-file", "--output", "--before", "--usage-file", "--backend-state-quiesced", "--issuer-id", "--issuer-key-file", "--issuer-project", "--issuer-route", "--operator-id", "--operator-key-file"]);
  for (let index = 0; index < tail.length; index += 2) {
    const key = tail[index], value = tail[index + 1]; if (!key || !allowed.has(key) || !value || flags.has(key)) throw new Error(usage); flags.set(key, value);
  }
  const required = (name: string) => { const value = flags.get(name); if (value === undefined) throw new Error(`required ${name}\n${usage}`); return value; };
  if (action === "prepare") {
    const directory = resolve(positional), api = flags.get("--api") ?? "responses";
    const operators = flags.has("--operator-id") || flags.has("--operator-key-file")
      ? [{ id: required("--operator-id"), keyFile: resolve(required("--operator-key-file")), role: "operator" as const }] : undefined;
    const config = parseConfig({ schemaVersion: 3, stateDirectory: join(directory, "state"), ...(operators === undefined ? {} : { operators }),
      hostIssuers: flags.has("--issuer-id") ? [{ id: required("--issuer-id"), keyFile: resolve(required("--issuer-key-file")), projects: [{ id: required("--issuer-project"), routeIds: [flags.get("--issuer-route") ?? "default"] }] }] : [],
      listen: { host: flags.get("--listen-host") ?? "127.0.0.1", port: Number(flags.get("--port") ?? 8318) }, backend: backendProfile,
      accounts: [{ id: "default", reference: required("--exclusive-account-reference"), endpoint: required("--backend"), keyFile: resolve(required("--backend-key-file")),
        ...(flags.has("--backend-auth-directory") ? { credentialDirectory: resolve(required("--backend-auth-directory")) } : {}) }],
      routes: [{ id: "default", accountId: "default", models: [{ id: required("--model"), name: required("--model"), api,
        context: integer(Number(required("--context-tokens"))), output: integer(Number(required("--output-tokens"))) }] }], limits: defaultLimits });
    await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, "router.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(`Prepared ${join(directory, "router.json")}. Review the exclusive backend/account contract, create a project, then serve.`); return;
  }
  if (action === "restore") { console.log(await restoreRouter(resolve(positional), resolve(required("--output")))); return; }
  const configActions = new Set(["serve", "operator-serve", "health", "projects", "principals", "active", "backup"]);
  const config = await loadConfig(resolve(configActions.has(action) ? positional : required("--config")));
  if (action === "serve" || action === "operator-serve") {
    const router = await (action === "operator-serve" ? createRouterOperatorServer(config) : createRouter(config));
    try { context.signal.throwIfAborted(); router.server.listen(config.listen); await once(router.server, "listening", { signal: context.signal });
      console.log(action === "operator-serve" ? "DIM LLM router operator listener ready; inference and recovery remain independently owned" : "DIM project LLM router listening; upstream login/refresh remains CLIProxyAPI-owned");
      await new Promise<void>((resolve) => { if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", () => resolve(), { once: true }); });
    } finally { await router.close(); } return;
  }
  const ledger = new RouterLedger(config.stateDirectory), guard = await tryAcquireKernelGuard(join(config.stateDirectory, "operator.guard"));
  if (!guard) { ledger.close(); throw new Error("another router operator command is running; retry after it finishes"); }
  try {
    if (action === "health") { console.log(JSON.stringify(await invokeRouterOperation(config, ledger, "health", {}), null, 2)); return; }
    if (action === "backup") { await backupRouter(config, resolve(required("--output")), { backendStateQuiesced: flags.get("--backend-state-quiesced") === "yes" }); console.log("Private consistent backup written; inspect its backendCredentials coverage before relying on it"); return; }
    if (action === "projects") { console.log(JSON.stringify(await invokeRouterOperation(config, ledger, "projects", {}), null, 2)); return; }
    if (action === "principals") { console.log(JSON.stringify(await invokeRouterOperation(config, ledger, "principals", {}), null, 2)); return; }
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
    if (action === "usage") { console.log(JSON.stringify(await invokeRouterOperation(config, ledger, "usage", { projectId: positional }), null, 2)); return; }
    if (action === "principal-revoke") { await invokeRouterOperation(config, ledger, "principal.revoke", { principalId: positional }); return; }
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
    throw new Error(usage);
  } finally { ledger.close(); await guard.release(); }
}
