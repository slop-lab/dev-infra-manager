import { OperatorInputError } from "./config.js";
import { requestMetadataSchema } from "@slop-lab/dim-contracts-llm-router";
import { randomBytes } from "node:crypto";
import type { HostProfile, OwnedWorkspace } from "./config.js";
import type { CommandResult } from "../web-lifecycle/process.js";
import type { MonitorClient } from "./monitor.js";
import path from "node:path";

export function parseOwnedRun(output: string) {
  const ids = new Set<string>(), tools: { readonly tool: string; readonly status: string }[] = [];
  let stopped = false;
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    const event = object(JSON.parse(line));
    if (event.type === "error" || typeof event.sessionID !== "string" || !/^ses_[A-Za-z0-9]{1,100}$/.test(event.sessionID)) throw new OperatorInputError("OpenCode run did not produce valid owned session evidence");
    ids.add(event.sessionID);
    const part = object(event.part);
    if (part.sessionID !== undefined && part.sessionID !== event.sessionID) throw new OperatorInputError("OpenCode event refers to another session");
    if (event.type === "step_finish" && part.reason === "stop") stopped = true;
    if (event.type === "tool_use") {
      const state = object(part.state);
      if (state.status === "error") throw new OperatorInputError("OpenCode file-tool execution failed");
      if (typeof state.status !== "string" || !["pending", "running", "completed"].includes(state.status)) throw new OperatorInputError("OpenCode tool status is invalid");
      const tool = typeof part.tool === "string" && ["read", "write", "edit", "apply_patch", "bash"].includes(part.tool) ? part.tool : "other";
      tools.push({ tool, status: state.status });
    }
  }
  const sessionId = [...ids][0];
  if (ids.size !== 1 || sessionId === undefined || !stopped || !tools.some((tool) => tool.tool === "read" && tool.status === "completed")
    || !tools.some((tool) => ["write", "edit", "apply_patch"].includes(tool.tool) && tool.status === "completed")) throw new OperatorInputError("OpenCode run lacks one fresh completed session and concrete file tools");
  return { sessionId, terminalReason: "stop" as const, tools };
}

export function correlateRouterRequests(value: unknown, scope: { readonly workspaceId: string; readonly projectId: string; readonly principalId: string; readonly routeId: string; readonly model: string; readonly nonce: string }) {
  const requests = requestMetadataSchema.array().max(200).parse(value).filter((row) => row.request_nonce === scope.nonce);
  if (requests.length === 0 || new Set(requests.map(({ id }) => id)).size !== requests.length) throw new OperatorInputError("no unique routed requests correlate with this run nonce");
  for (const row of requests) {
    if (row.workspace_id !== scope.workspaceId || row.project_id !== scope.projectId || row.principal_id !== scope.principalId || row.route_id !== scope.routeId
      || row.model !== scope.model || row.observed_model !== scope.model || row.outcome !== "completed" || row.execution !== "completed" || row.delivery !== "complete"
      || row.accounting !== "settled" || row.occupied !== 0 || row.error_code !== null || row.finished_at === null || row.input_tokens === null || row.output_tokens === null
      || row.input_tokens + row.output_tokens === 0) throw new OperatorInputError("correlated router work has foreign scope, wrong model or incomplete accounting");
  }
  return { ...scope, requestIds: requests.map(({ id }) => id), attemptIds: requests.map(({ attempt_id }) => attempt_id),
    accountIds: [...new Set(requests.map(({ account_id }) => account_id))], providerQualification: "not-assessed" as const };
}

export async function executeOwnedInference(input: { readonly profile: HostProfile; readonly workspace: OwnedWorkspace;
  readonly run: (step: string, args: readonly string[], timeout?: number) => Promise<CommandResult> }) {
  const { profile, workspace, run } = input, nonce = randomBytes(16).toString("hex");
  const directory = (await run("owned inference working directory", ["exec", workspace.name, "--", "pwd", "-P"])).stdout.trim();
  if (path.posix.normalize(directory) !== directory || !(directory === "/workspace" || directory.startsWith("/workspace/")) || /[\\\x00-\x20\x7f]/.test(directory)) throw new OperatorInputError("owned inference directory is outside the workspace");
  const identity = object(JSON.parse((await run("scoped LLM public identity", ["exec", workspace.name, "--", "node", "-e",
    'const fs=require("node:fs"),p=require("node:path");const v=JSON.parse(fs.readFileSync(p.join(process.env.HOME,".config/dim/llm-router.json"),"utf8"));process.stdout.write(JSON.stringify({workspaceId:v.workspaceId,projectId:v.projectId,principalId:v.principalId}))'])).stdout));
  if (identity.workspaceId !== workspace.id || identity.projectId !== profile.llm.project || typeof identity.principalId !== "string" || !/^[a-f0-9]{64}$/.test(identity.principalId)) throw new OperatorInputError("retained LLM identity does not match this owned workspace/project");
  const prompt = "Use your file tools to read selected-host-input.txt. Create selected-host-llm.txt containing exactly the same token and no other text. Finish only after writing the file.";
  const response = await run("routed OpenCode model and file-tool execution", ["exec", workspace.name, "--", "env", `DIM_LLM_ROUTER_REQUEST_NONCE=${nonce}`,
    "dim-agent", "opencode", "run", "--format", "json", "--model", `${profile.llm.provider}/${profile.llm.model}`, prompt], 10 * 60_000);
  const session = parseOwnedRun(response.stdout);
  const records: unknown = JSON.parse((await run("scoped router nonce accounting", ["llm-router", "requests", "--connection", profile.llm.operatorConnectionFile,
    "--project", profile.llm.project, "--limit", "200"])).stdout);
  const accounting = correlateRouterRequests(records, { workspaceId: workspace.id, projectId: profile.llm.project, principalId: identity.principalId,
    routeId: profile.llm.route, model: profile.llm.model, nonce });
  return { ...session, directory, provider: profile.llm.provider, model: profile.llm.model, accounting };
}

export async function verifyOwnedSessionModel(client: MonitorClient, run: { readonly sessionId: string; readonly provider: string; readonly model: string }) {
  const value = await client.get(`/session/${run.sessionId}/message?limit=20`, 30_000);
  if (!Array.isArray(value)) throw new OperatorInputError("owned session messages are unavailable");
  const assistants = value.map(object).map((message) => object(message.info)).filter((info) => info.role === "assistant");
  if (assistants.length === 0 || assistants.some((info) => info.sessionID !== run.sessionId || info.providerID !== run.provider || info.modelID !== run.model || info.error !== undefined)) throw new OperatorInputError("owned session did not execute exclusively through the expected DIM provider/model");
  return { sessionId: run.sessionId, provider: run.provider, model: run.model, assistantMessages: assistants.length };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OperatorInputError("invalid owned inference metadata");
  return Object.fromEntries(Object.entries(value));
}
