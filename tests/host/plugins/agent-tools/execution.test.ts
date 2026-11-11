import { expect, it, vi } from "vitest";
import { inspectOpenCodeMonitor, type MonitorClient } from "../../../../packages/host/plugins/agent-tools/src/execution/monitor.ts";
import { executionRevision, waitForExecutionChange, formatExecutionStatus } from "../../../../packages/host/plugins/agent-tools/src/execution/status.ts";
import { projectExecutionStatus } from "../../../../packages/host/plugins/agent-tools/src/execution/projection.ts";
import { parseExecutionStatus } from "../../../../packages/host/plugins/agent-tools/src/execution/parse.ts";

const options = { parentSessionId: "ses_parent", directory: "/workspace", maxSessions: 8, maxDepth: 4, maxRequests: 32, recentMessages: 4, staleMinutes: 15, deadlineMs: 5000, requestTimeoutMs: 500 };
const unavailable = { source: "unavailable", enabled: null, teams: [], truncated: false, unreadable: true };
const client = (busy = false): MonitorClient => ({ async get(path) {
  if (path === "/experimental/tool/ids") return ["team_list"];
  if (path === "/session/status") return busy ? { ses_parent: { type: "busy" } } : {};
  if (path === "/session?limit=8") return [{ id: "ses_parent" }];
  if (path === "/session/ses_parent") return { id: "ses_parent" };
  return [];
} });

it("keeps unavailable team discovery unknown despite empty teams and an idle parent", async () => {
  const evidence = await inspectOpenCodeMonitor(options, unavailable, client());
  expect(evidence).toMatchObject({ state: "unknown", discovery: "partial", team: { source: "unavailable", teams: [] } });
  expect(formatExecutionStatus(projectExecutionStatus(evidence))).toContain("teams unknown");
});

it("preserves positive activity while team discovery is unknown", async () => {
  expect(await inspectOpenCodeMonitor(options, unavailable, client(true))).toMatchObject({ state: "active", discovery: "partial" });
});

it("does not report idle when OMO says a member is active but its API is idle", async () => {
  const team = { source: "optional-omo-adapter", enabled: true, truncated: false, unreadable: false, teams: [{ leadSessionId: "ses_parent", status: "active", modifiedAt: "2026-11-11T00:00:00.000Z", members: [{ sessionId: "ses_child", status: "running" }] }] };
  const evidence = await inspectOpenCodeMonitor(options, team, client());
  expect(evidence.state).toBe("unknown");
  expect(evidence.sessions.find(row => row.sessionId === "ses_child")?.sourceDisagreement).toBe(true);
});

it("keeps an active OMO lead with no members unknown when the API is quiescent", async () => {
  const team = { source: "optional-omo-adapter", enabled: true, truncated: false, unreadable: false, teams: [{ leadSessionId: "ses_parent", status: "active", modifiedAt: "2026-11-11T00:00:00.000Z", members: [] }] };
  expect(await inspectOpenCodeMonitor(options, team, client())).toMatchObject({ state: "unknown", sessions: [{ sourceDisagreement: true }] });
});

it.each(["busy", "retry", "pending", "failed", "error", "errored", "unknown"])("does not turn OMO %s into idle", async status => {
  const team = { source: "optional-omo-adapter", enabled: true, truncated: false, unreadable: false, teams: [{ leadSessionId: "ses_parent", status, modifiedAt: "2026-11-11T00:00:00.000Z", members: [] }] };
  expect((await inspectOpenCodeMonitor(options, team, client())).state).toBe("unknown");
});

it("rejects contradictory idle counts, tools, membership and unknown pending input at the host boundary", async () => {
  const idleClient: MonitorClient = { async get(path, timeout) { return path === "/experimental/tool/ids" ? [] : client().get(path, timeout); } };
  const idle = projectExecutionStatus(await inspectOpenCodeMonitor(options, { ...unavailable, unreadable: false }, idleClient));
  expect(parseExecutionStatus(idle).state).toBe("idle");
  for (const change of [
    { activeChildren: 1 }, { currentFailures: 1 }, { totalChildren: 2 }, { pendingQuestions: 1 }, { pendingPermissions: null },
    { sessions: idle.sessions.map(row => ({ ...row, activity: "active" })) },
    { sessions: idle.sessions.map(row => ({ ...row, runningTools: [{ tool: "bash", status: "running" }] })) },
    { teamRuns: [{ leadSessionId: "ses_parent", status: "active", members: [] }] }
  ]) expect(() => parseExecutionStatus({ ...idle, ...change })).toThrow();
});

it("waits at least one minute between observations and stops on semantic change", async () => {
  vi.useFakeTimers();
  try {
    const first = projectExecutionStatus(await inspectOpenCodeMonitor(options, unavailable, client()));
    const next = projectExecutionStatus(await inspectOpenCodeMonitor(options, unavailable, client(true)));
    const observe = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    const waiting = waitForExecutionChange({ observe, signal: new AbortController().signal, timeoutMs: 120_000 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(observe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toMatchObject({ outcome: "changed", observations: 2, evidence: { state: "active" } });
    expect(observe).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it("ignores request counts and metadata timestamps in change detection and times out without changing evidence", async () => {
  vi.useFakeTimers();
  try {
    const raw = await inspectOpenCodeMonitor(options, unavailable, client());
    const evidence = projectExecutionStatus(raw);
    expect(executionRevision(evidence)).toBe(executionRevision(projectExecutionStatus({ ...raw, requestCount: 99 })));
    const observe = vi.fn().mockResolvedValue(evidence);
    const waiting = waitForExecutionChange({ observe, signal: new AbortController().signal, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await waiting).toMatchObject({ outcome: "timed-out", evidence: { state: "unknown" }, observations: 1 });
  } finally { vi.useRealTimers(); }
});

it("propagates caller cancellation without cancelling the observed task", async () => {
  const evidence = projectExecutionStatus(await inspectOpenCodeMonitor(options, unavailable, client()));
  const cancellation = new AbortController();
  const observe = vi.fn().mockResolvedValue(evidence);
  const waiting = waitForExecutionChange({ observe, signal: cancellation.signal, timeoutMs: 60_000 });
  const rejected = expect(waiting).rejects.toThrow();
  cancellation.abort();
  await rejected;
  expect(observe.mock.calls.length).toBeLessThanOrEqual(1);
});

it("reports a deadline before the first observation without inventing idle evidence", async () => {
  const observe = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  expect(await waitForExecutionChange({ observe, signal: new AbortController().signal, timeoutMs: 5 })).toEqual({ outcome: "timed-out", observations: 0, revision: null, evidence: null });
});
