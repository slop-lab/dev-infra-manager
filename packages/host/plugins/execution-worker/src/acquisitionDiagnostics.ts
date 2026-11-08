import type { Writable } from "node:stream";

export type CandidateAcquisitionPhase = "candidate-acquisition" | "credential-acquisition" | "protected-head" | "candidate-fetch"
  | "source-context-fetch" | "object-verification" | "materialize" | "runner-image" | "job-image"
  | "source-blobs" | "source-context" | "candidate-verification";

export type AcquisitionProcessMetrics = {
  stdoutBytes: number; stderrBytes: number; exitCode: number | null; timeoutMilliseconds: number;
  termination?: "timeout" | "aborted" | "output-limit" | "process-unavailable";
};

const phases = new WeakMap<object, CandidateAcquisitionPhase>();

/** Trusted operation labels only: messages, arguments and causes never enter job logs. */
export class CandidateAcquisitionError extends Error {
  constructor(readonly phase: CandidateAcquisitionPhase, cause: unknown) {
    super("trusted candidate acquisition failed", { cause });
  }
}
export async function acquisitionOperation<T>(phase: CandidateAcquisitionPhase, operation: () => Promise<T>,
  diagnostics?: Writable, metrics?: AcquisitionProcessMetrics): Promise<T> {
  const started = performance.now(); let status: "success" | "failure" = "failure";
  const emit = (event: "start" | "finish"): void => {
    try {
      diagnostics?.write(JSON.stringify({ component: "candidate-acquisition", phase, event,
        ...(event === "start" ? {} : { status, elapsedMilliseconds: Math.ceil(performance.now() - started),
          ...(metrics === undefined ? {} : { stdoutBytes: metrics.stdoutBytes, stderrBytes: metrics.stderrBytes,
            exitCode: metrics.exitCode, timeoutMilliseconds: metrics.timeoutMilliseconds,
            ...(metrics.termination === undefined ? {} : { termination: metrics.termination }) }) }) }) + "\n");
    } catch { /* Presentation must not replace the owning operation's result. */ }
  };
  emit("start");
  try { const result = await operation(); status = "success"; return result; }
  catch (error) {
    const failure = (typeof error === "object" && error !== null) || typeof error === "function" ? error : new CandidateAcquisitionError(phase, error);
    if (!phases.has(failure)) phases.set(failure, phase);
    throw failure;
  } finally { emit("finish"); }
}
export function writeAcquisitionDiagnostic(output: Writable, error: unknown, code: string | undefined): void {
  if (typeof error !== "object" || error === null) return;
  const phase = phases.get(error);
  if (phase === undefined) return;
  // The caller supplies only its closed mapping of known failure classes.
  output.write(JSON.stringify({ component: "candidate-acquisition", phase,
    code: code ?? "candidate-acquisition-failed" }) + "\n");
}
