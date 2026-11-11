import type { ExecutionStatus } from "./status.ts";

export function parseExecutionStatus(input: unknown): ExecutionStatus {
  const row = object(input);
  if (row.schemaVersion !== 1 || row.runtime !== "opencode" || row.completion !== "not-assessed") throw Error("Invalid execution status");
  const sessions = array(row.sessions, 16).map(raw => {
    const session = object(raw);
    if (typeof session.sourceDisagreement !== "boolean") throw Error("Invalid execution disagreement");
    const sessionId = id(session.sessionId);
    if (sessionId === null) throw Error("Missing execution session");
    return { sessionId, parentId: id(session.parentId), activity: activity(session.activity),
      omoStatus: session.omoStatus === null ? null : status(session.omoStatus), sourceDisagreement: session.sourceDisagreement,
      runningTools: array(session.runningTools, 200).map(rawTool => {
        const tool = object(rawTool);
        return { tool: choice(tool.tool, ["task", "background_task", "background_output", "background_cancel", "delegate_task", "call_omo_agent", "bash", "read", "apply_patch", "todowrite", "lsp_diagnostics", "other"]), status: choice(tool.status, ["pending", "running"]) };
      }) };
  });
  let members = 16;
  const teamRuns = array(row.teamRuns, 16).map(raw => {
    const team = object(raw), selected = array(team.members, members); members -= selected.length;
    return { leadSessionId: id(team.leadSessionId), status: status(team.status), members: selected.map(rawMember => {
      const member = object(rawMember); return { sessionId: id(member.sessionId), status: status(member.status) };
    }) };
  });
  const result: ExecutionStatus = {
    schemaVersion: 1, runtime: "opencode", state: choice(row.state, ["active", "waiting", "idle", "error", "unknown", "unreachable"]), completion: "not-assessed",
    parent: activity(row.parent), discovery: choice(row.discovery, ["complete-child-tree", "partial", "bounded-truncated"]),
    activeChildren: count(row.activeChildren), totalChildren: nullableCount(row.totalChildren),
    currentFailures: count(row.currentFailures), historicalFailures: count(row.historicalFailures),
    pendingQuestions: nullableCount(row.pendingQuestions), pendingPermissions: nullableCount(row.pendingPermissions),
    teams: choice(row.teams, ["known", "absent", "unknown"]), sessions, teamRuns
  };
  const active = sessions.filter(row => ["active", "active-stale", "retrying"].includes(row.activity));
  if (result.parent !== (sessions[0]?.activity ?? "unknown") || result.activeChildren !== sessions.slice(1).filter(row => active.includes(row)).length
    || result.currentFailures !== sessions.filter(row => row.activity === "error").length || result.historicalFailures !== sessions.filter(row => row.activity === "historical-error").length
    || result.discovery === "complete-child-tree" && (sessions.length === 0 || result.totalChildren !== sessions.length - 1)
    || result.discovery !== "complete-child-tree" && result.totalChildren !== null || result.teams === "absent" && teamRuns.length > 0) throw Error("Contradictory execution evidence");
  if (result.state === "idle" || result.state === "error") {
    if (result.discovery !== "complete-child-tree" || result.teams === "unknown" || result.pendingQuestions !== 0 || result.pendingPermissions !== 0
      || active.length > 0 || sessions.some(row => row.sourceDisagreement || row.activity === "unknown" || row.runningTools.length > 0)
      || teamRuns.some(team => !quiescent(team.status) || team.members.some(member => !quiescent(member.status)))
      || (result.state === "idle" ? result.currentFailures !== 0 : result.currentFailures === 0)) throw Error("Unproven quiescent execution status");
  }
  if (result.state === "active" && active.length === 0 || result.state === "waiting" && (result.pendingQuestions ?? 0) + (result.pendingPermissions ?? 0) === 0) throw Error("Unproven active execution status");
  return result;
}

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid execution object"); return Object.fromEntries(Object.entries(value)); }
function array(value: unknown, maximum: number): readonly unknown[] { if (!Array.isArray(value) || value.length > maximum) throw Error("Execution collection limit"); return value; }
function id(value: unknown): string | null { if (value === null) return null; if (typeof value === "string" && /^ses_[A-Za-z0-9]{1,100}$/.test(value)) return value; throw Error("Invalid execution session"); }
function count(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) throw Error("Invalid execution count"); return value; }
function nullableCount(value: unknown): number | null { return value === null ? null : count(value); }
function choice<const T extends string>(value: unknown, choices: readonly T[]): T { const selected = choices.find(candidate => candidate === value); if (selected === undefined) throw Error("Invalid execution state"); return selected; }
function activity(value: unknown) { return choice(value, ["active", "active-stale", "retrying", "idle", "error", "historical-error", "unknown"]); }
function status(value: unknown) { return choice(value, ["active", "running", "creating", "shutdown_requested", "idle", "busy", "retry", "errored", "error", "completed", "stopped", "pending", "failed", "shutdown", "deleting", "deleted", "unknown"]); }
function quiescent(value: string) { return ["idle", "completed", "stopped", "shutdown", "deleted"].includes(value); }
