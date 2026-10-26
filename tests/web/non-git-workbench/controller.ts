import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { executionOperations } from "../../../packages/service-clients/execution/src/console.js";
import { llmOperations } from "../../../packages/contracts/llm-router/src/index.js";
import { parseWorkbenchState } from "./state.js";
import {z} from 'zod';
import { tryAcquireKernelGuard } from '../../../packages/control-plane/core/src/lock.js';

const statePath = process.env.DIM_NON_GIT_WORKBENCH_STATE;
if (statePath === undefined) throw new Error("DIM_NON_GIT_WORKBENCH_STATE is required");
const rawArgs = process.argv.slice(2);
const selector = rawArgs[0] === "--host" ? rawArgs[1] : undefined;
if (selector === undefined) throw new Error("fixture controller requires --host");
const args = rawArgs.slice(2).filter((argument) => argument !== "--json");
const guard = await tryAcquireKernelGuard(`${statePath}.guard`, { timeoutMilliseconds: 5000 });
if (guard === undefined) throw new Error('synthetic state is busy');
try {
const state = parseWorkbenchState(await readFile(statePath, "utf8"));
const selectedHost = state.hosts[selector];
if (selectedHost === undefined) throw new Error("unknown synthetic host");
if (!selectedHost.available) process.exit(2);
const host = selectedHost;

const descriptors = (operations: readonly { readonly name: string; readonly description: string; readonly access: string }[]) =>
  operations.map(({ name, description, access }) => ({ name, description, access }));
const argument = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const input = (): Record<string, unknown> => {
  const inline = argument("--input");
  const value = args.includes("--input-stdin") || inline === "-" ? awaitInput : inline;
  return z.record(z.string(),z.unknown()).parse(JSON.parse(value ?? '{}'));
};
const awaitInput = args.includes("--input-stdin") || argument("--input") === "-"
  ? await new Promise<string>((resolve) => { let body = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk: string) => { body += chunk; }); process.stdin.on("end", () => resolve(body)); })
  : undefined;
const save = async (): Promise<void> => writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };

const workspace = (name: unknown, id: unknown) => host.workspaces.find((entry) => entry.name === name && entry.id === id);
const routeSnapshot = (selected: NonNullable<ReturnType<typeof workspace>>) => ({
  workspace: selected.name,
  workspaceId: selected.id,
  ingresses: [
    { name: "shared", description: "Synthetic shared HTTPS ingress", scheme: "https", driver: "fixture" },
    { name: "host", description: "Synthetic host relay", scheme: "http", driver: "fixture" }
  ],
  routes: host.routes[selected.id] ?? []
});
const serverSnapshot = (selected: NonNullable<ReturnType<typeof workspace>>) => ({
  workspace: selected.name,
  workspaceId: selected.id,
  state: host.servers[selected.id] ?? "stopped",
  port: 4096,
  url: "http://127.0.0.1:4096",
  directory: "/workspace/main",
  username: "opencode",
  credentialsFile: "/workspace/.local/share/opencode/auth.json",
  logFile: "/workspace/.local/state/opencode/server.log"
});

const generationId = "a".repeat(64);
const finishedJob = { id: "67094660-a627-4a17-acd2-6418c0b79967", eventId: "b".repeat(64), projectId: "non-git", repositoryId: "workspace", jobName: "environment-validation", executionKind: "ordinary-sysbox", phase: "finished", generationId, createdAt: Date.now() - 60_000, publication: "stale", outcome: "failure", completion: { kind: "executor-failure", code: "dependency-unavailable" }, finishedAt: new Date().toISOString() };
const queuedJob = { id: "77094660-a627-4a17-acd2-6418c0b79967", eventId: "c".repeat(64), projectId: "non-git", repositoryId: "workspace", jobName: "browser-task", executionKind: "ordinary-sysbox", phase: "queued", generationId, createdAt: Date.now(), publication: "pending" };
const jobs = [queuedJob, finishedJob];
const limits = { concurrent: 4, requestsPerUtcDay: 500, requestBytes: 1_048_576, responseBytes: 4_194_304, captureBytesPerProject: 67_108_864, deadlineMilliseconds: 120_000 };
const policy = { allowedRoutes: ["balanced", "codex"], limits, captureMode: "metadata", tokenMode: "observe" };
const project = { id: "workbench", enabled: true, paused: false, revision: "d".repeat(64), policy };
const accounts = [
  { id: "team-api", reference: "Synthetic compatible API", provider: "openai", status: "connected" },
  { id: "codex-browser", reference: "Synthetic Codex device account", provider: "codex", status: "authorization_required" }
];
const models = [{ id: "gpt-5.6", name: "GPT 5.6 synthetic", api: "responses", context: 128_000, output: 16_384 }];

async function main(): Promise<void> {
  const [domain, section, action, operation] = args;
  if (domain === "ls") return print(host.workspaces);
  if (["start", "stop", "restart", "recreate", "discard", "resources"].includes(domain ?? "")) {
    const selected = host.workspaces.find((entry) => entry.name === section);
    if (selected === undefined) throw new Error("workspace not found");
    if (domain === "discard") host.workspaces.splice(host.workspaces.indexOf(selected), 1);
    else if (domain === "stop") { selected.phase = "stopped"; selected.runtimeStatus = "stopped"; }
    else if (domain === "resources") selected.resources = { cpuCount: argument("--cpus") ?? selected.resources.cpuCount, memory: argument("--memory") ?? selected.resources.memory, pidsLimit: argument("--pids") ?? selected.resources.pidsLimit };
    else { selected.phase = "running"; selected.runtimeStatus = "running"; }
    await save(); return print(selected);
  }
  if (domain === "create") {
    const name = action;
    if (name === undefined) throw new Error("workspace name missing");
    const selected = { id: randomUUID(), name, runtime: argument("--runtime") ?? "container", phase: "running", runtimeStatus: "running", resources: { cpuCount: argument("--cpus") ?? "2", memory: argument("--memory") ?? "4g", pidsLimit: argument("--pids") ?? "2048" } };
    host.workspaces.push(selected); await save(); return print(selected);
  }
  if (section !== "console") throw new Error("unsupported fixture command");
  if (domain === "tools" && action === "describe") return print({ schemaVersion: 1, workspaces: host.workspaces.map(({ name, id, phase }) => ({ name, id, phase })), tools: ["opencode", "codex"] });
  if (domain === "execution" && action === "describe") return print({ schemaVersion: 1, generationId, operations: descriptors(executionOperations) });
  if (domain === "llm-router" && action === "describe") return print({ schemaVersion: 1, selectionId: "e".repeat(64), operations: descriptors(llmOperations) });
  if (action !== "invoke" || operation === undefined) throw new Error("unsupported fixture operation");
  const body = input();
  const selected = workspace(body.workspace, body.workspaceId);
  if (domain === "tools") {
    if (selected === undefined) throw new Error("workspace identity mismatch");
    if (operation === "tools.status" || operation === "tools.setup") return print({ workspace: selected.name, workspaceId: selected.id, tools: [{ name: "opencode", version: "1.18.31", installed: true }, { name: "codex", version: "0.48.0", installed: true }] });
    if (operation === "server.start") host.servers[selected.id] = "running";
    if (operation === "server.stop") host.servers[selected.id] = "stopped";
    if (operation === "server.credentials") return print({ workspace: selected.name, workspaceId: selected.id, username: "opencode", password: "synthetic-only-password" });
    if (operation === "server.start" || operation === "server.stop") await save();
    return print(serverSnapshot(selected));
  }
  if (domain === "external-url") {
    if (selected === undefined) throw new Error("workspace identity mismatch");
    const routes = host.routes[selected.id] ?? [];
    if (operation === "routes.create") routes.push({ id: randomUUID(), ingress: String(body.ingress), url: `https://${String(body.name)}.synthetic.example`, permalink: `https://${String(body.name)}.permanent.synthetic.example`, approval: "pending", port: Number(body.port), containers: typeof body.container === "string" ? [body.container] : [], protocol: body.protocol === "tcp" || body.protocol === "https" ? body.protocol : "http" });
    const route = routes.find((entry) => entry.id === body.id);
    if (route !== undefined && operation === "routes.approve") route.approval = "approved";
    if (route !== undefined && operation === "routes.revoke") route.approval = "revoked";
    if (["routes.create", "routes.approve", "routes.revoke"].includes(operation)) { host.routes[selected.id] = routes; await save(); }
    return print(routeSnapshot(selected));
  }
  if (domain === "execution") {
    if (operation === "jobs.list") return print(jobs);
    if (operation === "jobs.detail") return print({ job: jobs.find(({ id }) => id === body.id) ?? queuedJob });
    if (operation === "workers.list") return print([{ id: "synthetic-worker", observedConnected: true, lastSeenAt: Date.now(), slots: [{ id: "sysbox-1", executionKind: "ordinary-sysbox", state: "busy", available: true, job: queuedJob, leaseExpiresAt: Date.now() + 60_000 }] }]);
    return print(operation === "jobs.retry" ? { ...queuedJob, id: randomUUID(), retryOf: body.id } : { ...finishedJob, cancelRequestedAt: Date.now() });
  }
  if (domain === "llm-router") return print({ schemaVersion: 1, outcome: "success", output: llmResponse(operation, body) });
  throw new Error("unsupported fixture domain");
}

function llmResponse(operation: string, body: Record<string, unknown>): unknown {
  if (operation === "capabilities") return descriptors(llmOperations);
  if (operation === "overview") return { backend: { name: "Synthetic provider fabric", version: "fixture-1", accountSelection: "explicit route", attemptVisibility: "metadata", cancellation: "best effort" }, accounts: accounts.map(({ id, reference }) => ({ id, reference })), routes: [{ id: "balanced", accountId: "team-api", models }, { id: "codex", accountId: "codex-browser", models: "all" }], limits };
  if (operation === "accounts") return accounts;
  if (operation === "account.models") return models;
  if (operation === "health") return accounts.map(({ id, reference }) => ({ accountId: id, reference, observedAt: new Date().toISOString(), backendAuthentication: id === "team-api" ? "accepted" : "authorization required", providerReachability: "synthetic", providerQuota: "unknown", billableInferencePerformed: false }));
  if (operation === "projects") return [project];
  if (operation === "project.policy") return project;
  if (operation === "usage") return { projectId: "workbench", requests: 12, knownInputTokens: 4200, knownOutputTokens: 900, unknownUsageRequests: 1, captureBytes: 2048, occupied: 1, backendDispatches: 11, tokenReservations: 0, allowance: { utcDay: "2026-10-26", enabled: true, paused: false, booking: "explicit", projectLimits: limits, serviceLimits: limits, admittedRequests: 12, remainingRequests: 488, occupied: 1, serviceOccupied: 1, tokenMode: "observe", tokenLimit: null, chargedTokensOrEstimates: 5100, unknownUnreservedRequests: 1, tokenReservations: 0, tokenAllowanceStatus: "observed", remainingEstimatedTokens: null, estimatedTokenOverage: null }, recent: [], observedAt: Date.now(), period: "UTC day", attemptVisibility: "metadata", accounting: "observed" };
  if (operation === "principals") return [{ id: "principal-studio", project_id: "workbench", workspace_id: "17094660-a627-4a17-acd2-6418c0b79967", workspace_name: "studio", route_id: "balanced", enabled: 1 }];
  if (operation === "requests") return [{ id: "87094660-a627-4a17-acd2-6418c0b79967", project_id: "workbench", principal_id: "principal-studio", account_id: "team-api", started_at: Date.now() - 1500, finished_at: Date.now() - 500, model: "gpt-5.6", outcome: "succeeded", execution: "completed", delivery: "delivered", accounting: "observed", occupied: 0, cancel_requested: 0, input_tokens: 420, output_tokens: 96, error_code: null }];
  if (operation === "account.login.start") return { accountId: body.accountId, sessionId: "synthetic-device-session", verificationUrl: "https://example.com/device", userCode: "DIM-SAFE", status: "pending", expiresAt: Date.now() + 600_000 };
  if (operation === "account.login.status") return { accountId: body.accountId, sessionId: body.sessionId, status: "pending", message: "Synthetic device flow; no provider contacted." };
  if (operation === "project.policy.update") return { ...project, revision: "f".repeat(64), policy: body.policy };
  if (operation === "project.state") return { ...project, paused: body.action === "pause", enabled: body.action !== "disable" };
  if (operation === "principal.revoke") return { revoked: true };
  if (operation === "request.cancel") return { cancellationRequested: true, upstreamTerminationConfirmed: false };
  if (operation === "request.resolve") return { resolved: true };
  if (operation === "route.upsert") return { id: body.routeId, accountId: body.accountId, models: body.models };
  if (operation === "account.rename" || operation === "account.create") return accounts[0];
  if (operation === "project.create") return { ...project, id: body.projectId };
  throw new Error(`unsupported LLM operation ${operation}`);
}

await main();
} finally { await guard.release(); }
