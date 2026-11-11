import { createHash } from "node:crypto";

export type ExecutionStatus = {
  readonly schemaVersion: 1;
  readonly runtime: string;
  readonly state: "active" | "waiting" | "idle" | "error" | "unknown" | "unreachable";
  readonly completion: "not-assessed";
  readonly parent: string;
  readonly discovery: "complete-child-tree" | "partial" | "bounded-truncated";
  readonly activeChildren: number;
  readonly totalChildren: number | null;
  readonly currentFailures: number;
  readonly historicalFailures: number;
  readonly pendingQuestions: number | null;
  readonly pendingPermissions: number | null;
  readonly teams: "known" | "absent" | "unknown";
  readonly sessions: readonly { readonly sessionId: string; readonly parentId: string | null; readonly activity: string; readonly omoStatus: string | null; readonly sourceDisagreement: boolean; readonly runningTools: readonly { readonly tool: string; readonly status: string }[] }[];
  readonly teamRuns: readonly { readonly leadSessionId: string | null; readonly status: string; readonly members: readonly { readonly sessionId: string | null; readonly status: string }[] }[];
};

export function executionRevision(evidence: ExecutionStatus): string {
  const sessions = [...evidence.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const teamRuns = evidence.teamRuns.map(team => ({ ...team, members: [...team.members].sort((a, b) => (a.sessionId ?? "").localeCompare(b.sessionId ?? "")) }))
    .sort((a, b) => (a.leadSessionId ?? "").localeCompare(b.leadSessionId ?? "") || a.status.localeCompare(b.status));
  return createHash("sha256").update(JSON.stringify({ ...evidence, sessions, teamRuns })).digest("hex");
}

export async function waitForExecutionChange(input: {
  readonly observe: (signal: AbortSignal) => Promise<ExecutionStatus>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly since?: string;
}) {
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 180_000 || input.since !== undefined && !/^[a-f0-9]{64}$/.test(input.since)) throw Error("Invalid execution wait bounds");
  const deadline = performance.now() + input.timeoutMs;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]);
  input.signal.throwIfAborted();
  let evidence: ExecutionStatus;
  try { evidence = await input.observe(signal); }
  catch (error) {
    input.signal.throwIfAborted();
    if (!signal.aborted) throw error;
    return { outcome: "timed-out" as const, revision: null, observations: 0, evidence: null };
  }
  let observations = 1;
  const baseline = input.since ?? executionRevision(evidence);
  for (;;) {
    input.signal.throwIfAborted();
    const revision = executionRevision(evidence);
    if (revision !== baseline) return { outcome: "changed" as const, revision, observations, evidence };
    const remaining = deadline - performance.now();
    if (remaining <= 60_000 || observations >= 3) {
      if (remaining > 0) await pause(remaining, input.signal);
      return { outcome: "timed-out" as const, revision, observations, evidence };
    }
    await pause(60_000, input.signal);
    try { evidence = await input.observe(signal); observations++; }
    catch (error) {
      input.signal.throwIfAborted();
      if (!signal.aborted) throw error;
      return { outcome: "timed-out" as const, revision, observations, evidence };
    }
  }
}

export function formatExecutionStatus(evidence: ExecutionStatus): string {
  return `${evidence.state}; parent ${evidence.parent}; ${evidence.activeChildren} active subagents, total ${evidence.totalChildren ?? "unknown"}; teams ${evidence.teams}; discovery ${evidence.discovery}; completion not assessed`;
}

async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
