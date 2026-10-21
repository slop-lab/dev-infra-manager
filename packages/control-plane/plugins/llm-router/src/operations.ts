import { llmOperation, llmOperations } from "@slop-lab/dim-llm-router-client";
import { operationDescriptors } from "@slop-lab/dim-contracts-operations";
import { object, parsePolicy, text, type RouterConfig } from "./config.js";
import { type RouterLedger, type Usage } from "./ledger.js";
import { accountHealth } from "./operator.js";
/** One implementation for local operator CLI and authenticated remote clients. */
export async function invokeRouterOperation(config: RouterConfig, ledger: RouterLedger, name: string, raw: unknown, actor = "operator", role: "read" | "operator" = "operator"): Promise<unknown> {
  const operation = llmOperation(name), input = object(operation.parseInput(raw));
  const projectId = () => text(input.projectId);
  const policy = (value: unknown) => { const result = parsePolicy(value); if (result.allowedRoutes.some((id) => !config.routes.some((route) => route.id === id))) throw new Error("policy refers to an unknown route"); return result; };
  let output: unknown;
  switch (name) {
    case "capabilities": output = operationDescriptors(llmOperations.filter((op) => op.access === "read" || role === "operator" && op.access === "operator")); break;
    case "overview": output = { backend: config.backend, accounts: config.accounts.map(({ id, reference }) => ({ id, reference })), routes: config.routes, limits: config.limits }; break;
    case "health": output = await accountHealth(config); break;
    case "projects": output = ledger.projects(); break;
    case "project.create": ledger.createProject(projectId(), policy({ allowedRoutes: [input.routeId], limits: config.limits, captureMode: "required", tokenMode: "observe" })); output = ledger.project(projectId()); break;
    case "project.policy": output = ledger.project(projectId()); break;
    case "project.policy.update": ledger.updatePolicy(projectId(), policy(input.policy), text(input.expectedRevision)); output = ledger.project(projectId()); break;
    case "project.state": {
      const action = input.action; if (action !== "pause" && action !== "resume" && action !== "enable" && action !== "disable") throw new Error("invalid project action");
      ledger.setProject(projectId(), action); output = ledger.project(projectId()); break;
    }
    case "usage": output = ledger.usage(projectId(), config.limits); break;
    case "principals": output = ledger.database.prepare("SELECT id,project_id,workspace_id,workspace_name,route_id,enabled FROM principals ORDER BY id LIMIT 1000").all(); break;
    case "principal.revoke": ledger.revoke(text(input.principalId)); output = { revoked: true }; break;
    case "requests": {
      const filters: string[] = [], values: (string | number)[] = [];
      if (input.projectId !== undefined) { filters.push("project_id=?"); values.push(text(input.projectId)); }
      if (input.active === true) filters.push("(occupied=1 OR outcome='running')");
      values.push(typeof input.limit === "number" ? input.limit : 100);
      output = ledger.database.prepare(`SELECT id,project_id,principal_id,account_id,started_at,finished_at,requested_model AS model,outcome,execution,delivery,accounting,occupied,cancel_requested,input_tokens,output_tokens,error_code FROM requests ${filters.length ? "WHERE " + filters.join(" AND ") : ""} ORDER BY started_at DESC,rowid DESC LIMIT ?`).all(...values); break;
    }
    case "request.cancel": ledger.cancel(text(input.requestId), actor); output = { cancellationRequested: true, upstreamTerminationConfirmed: false }; break;
    case "request.resolve": {
      let usage: Usage | undefined;
      if (input.usage !== undefined) { const row = object(input.usage); usage = { inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens), raw: row, source: "operator-resolution" }; }
      ledger.resolve(text(input.requestId), usage); output = { resolved: true }; break;
    }
    default: throw new Error("unknown LLM router operation");
  }
  const result = operation.parseOutput(output);
  ledger.audit(actor, `remote.${name}`, typeof input.projectId === "string" ? input.projectId : "router");
  return result;
}
