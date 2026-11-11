import type { MonitorEvidence } from "./monitor.ts";
import type { ExecutionStatus } from "./status.ts";

export function projectExecutionStatus(evidence: MonitorEvidence): ExecutionStatus {
  const selected = new Set(evidence.sessions.map(row => row.sessionId));
  return {
    schemaVersion: 1, runtime: "opencode", state: evidence.state, completion: "not-assessed", parent: evidence.parent,
    discovery: evidence.discovery, activeChildren: evidence.activeChildren,
    totalChildren: evidence.discovery === "complete-child-tree" ? Math.max(0, evidence.sessions.length - 1) : null,
    currentFailures: evidence.currentFailures, historicalFailures: evidence.historicalFailures,
    pendingQuestions: evidence.pendingQuestions, pendingPermissions: evidence.pendingPermissions,
    teams: evidence.teamToolInventory === "absent" ? "absent" : evidence.team.source === "unavailable" || evidence.team.enabled === null || evidence.team.unreadable || evidence.team.truncated || evidence.teamToolInventory === "unknown" ? "unknown" : "known",
    sessions: evidence.sessions.map(({ sessionId, parentId, activity, omoStatus, sourceDisagreement, runningTools }) => ({ sessionId, parentId, activity, omoStatus, sourceDisagreement, runningTools })),
    teamRuns: evidence.team.teams.filter(row => row.leadSessionId !== null && selected.has(row.leadSessionId))
      .map(({ leadSessionId, status, members }) => ({ leadSessionId, status, members: members.filter(row => row.sessionId !== null && selected.has(row.sessionId)) }))
  };
}
