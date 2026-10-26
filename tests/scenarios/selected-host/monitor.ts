export type MonitorOptions = {
  readonly parentSessionId: string;
  readonly directory: string;
  readonly maxSessions: number;
  readonly maxDepth: number;
  readonly maxRequests: number;
  readonly recentMessages: number;
  readonly staleMinutes: number;
  readonly deadlineMs: number;
  readonly requestTimeoutMs: number;
  readonly observedAtMs?: number;
};

export type MonitorClient = { readonly get: (path: string, timeoutMs: number) => Promise<unknown> };

type Activity = "active" | "active-stale" | "retrying" | "idle" | "error" | "historical-error" | "unknown";
type SessionRow = {
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly depth: number;
  readonly status: string;
  readonly activity: Activity;
  readonly lastActivity: string | null;
  readonly error: { readonly name: string; readonly statusCode: number | null } | null;
  readonly runningTools: readonly { readonly tool: string; readonly status: string }[];
  readonly omoStatus: string | null;
  readonly sourceDisagreement: boolean;
};
type SessionInput = {
  readonly id: string;
  readonly depth: number;
  readonly info: Record<string, unknown>;
  readonly status?: string;
  readonly messages: readonly unknown[];
  readonly readable: boolean;
  readonly omoStatus?: string;
  readonly staleMinutes: number;
  readonly now: number;
};

export type MonitorEvidence = {
  readonly state: "active" | "idle" | "error" | "unknown" | "unreachable";
  readonly reason?: "api-unavailable";
  readonly completion: "not-assessed";
  readonly parent: Activity | "unknown";
  readonly activeChildren: number;
  readonly staleActive: number;
  readonly currentFailures: number;
  readonly historicalFailures: number;
  readonly unknownSessions: number;
  readonly discovery: "complete-child-tree" | "partial" | "bounded-truncated";
  readonly requestCount: number | null;
  readonly teamToolInventory: "present" | "absent" | "unknown";
  readonly team: OmoTeamMetadata;
  readonly sessions: readonly SessionRow[];
};

const safeTools = new Set(["task", "background_task", "background_output", "background_cancel", "delegate_task", "call_omo_agent", "bash", "read", "apply_patch", "todowrite", "lsp_diagnostics"]);
const sessionPattern = /^ses_[A-Za-z0-9]{1,100}$/;

export async function inspectOpenCodeMonitor(options: MonitorOptions, team: OmoTeamMetadata, client: MonitorClient): Promise<MonitorEvidence> {
  const safeTeam = parseOmoTeamMetadata(team, options.maxSessions, options.maxSessions);
  try { return await inspect(options, safeTeam, client); }
  catch (error) {
    return {
      state: error instanceof MonitorLimitError ? "unknown" : "unreachable", ...(error instanceof MonitorLimitError ? {} : { reason: "api-unavailable" as const }), completion: "not-assessed", parent: "unknown",
      activeChildren: 0, staleActive: 0, currentFailures: 0, historicalFailures: 0, unknownSessions: 0,
      discovery: error instanceof MonitorLimitError ? "bounded-truncated" : "partial", requestCount: error instanceof MonitorLimitError ? error.requestCount : null, teamToolInventory: "unknown", team: safeTeam, sessions: []
    };
  }
}

async function inspect(options: MonitorOptions, team: OmoTeamMetadata, client: MonitorClient): Promise<MonitorEvidence> {
  const now = options.observedAtMs ?? Date.now();
  const deadline = Date.now() + options.deadlineMs;
  let requestCount = 0;
  const get = async (path: string): Promise<unknown> => {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (requestCount >= options.maxRequests) throw new MonitorLimitError("request-limit", requestCount);
      if (Date.now() > deadline) throw new MonitorLimitError("deadline", requestCount);
      requestCount += 1;
      try { return await client.get(path, Math.max(1, Math.min(options.requestTimeoutMs, deadline - Date.now()))); }
      catch (error) { failure = error; }
    }
    throw failure;
  };
  let teamToolInventory: "present" | "absent" | "unknown" = "unknown";
  try {
    const tools = array(await get("/experimental/tool/ids"));
    teamToolInventory = tools.some((tool) => typeof tool === "string" && tool.startsWith("team_")) ? "present" : "absent";
  } catch { teamToolInventory = "unknown"; }
  const statuses = statusMap(await get("/session/status"));
  let partial = team.unreadable || teamToolInventory === "unknown" || teamToolInventory === "present" && team.source === "unavailable", truncated = team.truncated;
  let listed: readonly unknown[] = [];
  try { listed = array(await get(`/session?limit=${options.maxSessions}`)); }
  catch (error) { if (error instanceof MonitorLimitError) truncated = true; else partial = true; }
  if (listed.length >= options.maxSessions) truncated = true;
  const indexed = new Map<string, Record<string, unknown>>();
  for (const value of listed.slice(0, options.maxSessions)) if (!addSession(indexed, value, options.maxSessions)) truncated = true;
  try { if (!addSession(indexed, await get(`/session/${encodeURIComponent(options.parentSessionId)}`), options.maxSessions)) truncated = true; }
  catch (error) { if (error instanceof MonitorLimitError) truncated = true; else partial = true; }

  const queue: { readonly id: string; readonly depth: number }[] = [{ id: options.parentSessionId, depth: 0 }];
  const queued = new Set([options.parentSessionId]);
  const enqueue = (id: string, depth: number) => {
    if (queued.has(id)) return;
    if (depth > options.maxDepth || queued.size >= options.maxSessions) { truncated = true; return; }
    queued.add(id); queue.push({ id, depth });
  };
  const visited = new Set<string>();
  const rows: SessionRow[] = [];
  const omoStatuses = new Map<string, string>();

  while (queue.length > 0 && rows.length < options.maxSessions) {
    const item = queue.shift();
    if (item === undefined || visited.has(item.id)) continue;
    visited.add(item.id);
    for (const runtime of team.teams.filter(({ leadSessionId }) => leadSessionId === item.id)) {
      for (const member of runtime.members) {
        if (member.sessionId === null) continue;
        omoStatuses.set(member.sessionId, member.status);
        enqueue(member.sessionId, item.depth + 1);
      }
    }

    let messages: readonly unknown[] = [];
    let messageReadable = true;
    try { messages = array(await get(`/session/${encodeURIComponent(item.id)}/message?limit=${options.recentMessages}`)); }
    catch (error) { if (error instanceof MonitorLimitError) truncated = true; else partial = true; messageReadable = false; }
    const info = indexed.get(item.id) ?? { id: item.id };
    const status = statuses.get(item.id) ?? "idle", omoStatus = omoStatuses.get(item.id);
    rows.push(sessionRow({ id: item.id, depth: item.depth, info, messages, readable: messageReadable,
      staleMinutes: options.staleMinutes, now,
      status, ...(omoStatus === undefined ? {} : { omoStatus }) }));

    let children = [...indexed.values()].filter((candidate) => candidate["parentID"] === item.id);
    try {
      const found = array(await get(`/session/${encodeURIComponent(item.id)}/children`));
      if (found.length > options.maxSessions) truncated = true;
      for (const child of found.slice(0, options.maxSessions)) {
        const info = record(child);
        if (info["parentID"] !== undefined && info["parentID"] !== item.id) partial = true;
        if (!addSession(indexed, { ...info, parentID: info["parentID"] ?? item.id }, options.maxSessions)) truncated = true;
      }
      children = [...indexed.values()].filter((candidate) => candidate["parentID"] === item.id);
    } catch (error) { if (error instanceof MonitorLimitError) truncated = true; else partial = true; }
    for (const child of children) {
      const id = child["id"];
      if (typeof id !== "string" || visited.has(id)) continue;
      enqueue(id, item.depth + 1);
    }
  }
  if (queue.length > 0) truncated = true;
  const incomplete = partial || truncated;
  const active = rows.filter(({ activity }) => activity === "active" || activity === "active-stale" || activity === "retrying");
  const state = active.length > 0 ? "active" : incomplete ? "unknown"
    : rows.some(({ activity }) => activity === "error") ? "error"
      : rows.some(({ activity }) => activity === "unknown") ? "unknown" : "idle";
  return {
    state, completion: "not-assessed", parent: rows[0]?.activity ?? "unknown",
    activeChildren: active.filter(({ depth }) => depth > 0).length,
    staleActive: active.filter(({ activity }) => activity === "active-stale").length,
    currentFailures: rows.filter(({ activity }) => activity === "error").length,
    historicalFailures: rows.filter(({ activity }) => activity === "historical-error").length,
    unknownSessions: rows.filter(({ activity }) => activity === "unknown").length,
    discovery: truncated ? "bounded-truncated" : partial ? "partial" : "complete-child-tree",
    requestCount, teamToolInventory, team, sessions: rows
  };
}

function sessionRow(input: SessionInput): SessionRow {
  const { id, depth, info, status, messages, readable, omoStatus, staleMinutes, now } = input;
  const records = messages.map(messageRecord).filter((value) => value !== null);
  const assistant = records.filter((message) => record(message["info"])["role"] === "assistant").at(-1);
  const error = record(record(assistant?.["info"])["error"]);
  const parts = records.flatMap((message) => arrayOrEmpty(message["parts"])).map(record);
  const runningTools = parts.filter((part) => part["type"] === "tool" && ["running", "pending"].includes(text(record(part["state"])["status"])))
    .map((part) => ({ tool: safeTool(part["tool"]), status: text(record(part["state"])["status"]) }));
  const times = [number(record(info["time"])["updated"]), ...records.flatMap((message) => messageTimes(message))].filter((value) => value !== null);
  const last = times.length === 0 ? null : Math.max(...times);
  const stale = last !== null && now - last > staleMinutes * 60_000;
  let activity: Activity;
  if (status === "retry") activity = "retrying";
  else if (status === "busy" || runningTools.length > 0) activity = stale ? "active-stale" : "active";
  else if (!readable) activity = "unknown";
  else if (Object.keys(error).length > 0) activity = depth > 0 && stale ? "historical-error" : "error";
  else activity = status === "idle" ? "idle" : "unknown";
  const runtimeActive = omoStatus !== undefined && ["active", "running", "creating", "shutdown_requested"].includes(omoStatus);
  const apiActive = activity === "active" || activity === "active-stale" || activity === "retrying";
  return {
    sessionId: id, parentId: sessionId(info["parentID"]), depth,
    status: status ?? "unknown", activity, lastActivity: last === null ? null : new Date(last).toISOString(),
    error: Object.keys(error).length === 0 ? null : { name: safeErrorName(error["name"]), statusCode: number(record(error["data"])["statusCode"]) },
    runningTools, omoStatus: omoStatus ?? null, sourceDisagreement: omoStatus !== undefined && runtimeActive !== apiActive
  };
}

function addSession(indexed: Map<string, Record<string, unknown>>, value: unknown, maximum: number): boolean {
  const session = record(value), id = session["id"];
  if (typeof id !== "string" || !sessionPattern.test(id) || !indexed.has(id) && indexed.size >= maximum) return false;
  indexed.set(id, { id, parentID: sessionId(session["parentID"]), time: { updated: number(record(session["time"])["updated"]) } });
  return true;
}
function statusMap(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
   for (const [id, raw] of Object.entries(record(value))) { const type = record(raw)["type"]; if (sessionPattern.test(id)) result.set(id, monitorStatus(type)); }
  return result;
}
function messageRecord(value: unknown): Record<string, unknown> | null { const found = record(value); return Object.keys(found).length === 0 ? null : found; }
function messageTimes(message: Record<string, unknown>): (number | null)[] {
  const info = record(message["info"]), values = [number(record(info["time"])["created"]), number(record(info["time"])["completed"])];
  for (const part of arrayOrEmpty(message["parts"]).map(record)) values.push(number(record(part["time"])["start"]), number(record(part["time"])["end"]), number(record(record(part["state"])["time"])["start"]), number(record(record(part["state"])["time"])["end"]));
  return values;
}
function safeTool(value: unknown): string { return typeof value === "string" && safeTools.has(value) ? value : "other"; }
function sessionId(value: unknown): string | null { return typeof value === "string" && sessionPattern.test(value) ? value : null; }
function safeErrorName(value: unknown): string { return typeof value === "string" && ["APIError", "UnknownError", "ProviderAuthError", "MessageAbortedError"].includes(value) ? value : "other"; }
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}; }
function array(value: unknown): readonly unknown[] { if (!Array.isArray(value)) throw new Error("monitor response must be an array"); return value; }
function arrayOrEmpty(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === "string" ? value : "unknown"; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : null; }

class MonitorLimitError extends Error {
  readonly name = "MonitorLimitError";
  constructor(kind: "request-limit" | "deadline", readonly requestCount: number) { super(kind); }
}
import { monitorStatus, parseOmoTeamMetadata, type OmoTeamMetadata } from "./monitorMetadata.js";
export { parseOmoTeamMetadata, type OmoTeamMetadata } from "./monitorMetadata.js";
