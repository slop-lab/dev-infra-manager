import type { Writable } from "node:stream";

export type CandidateAcquisitionPhase = "candidate-acquisition" | "credential-acquisition" | "protected-head" | "candidate-fetch"
  | "source-context-fetch" | "object-verification" | "materialize";

const phases = new WeakMap<object, CandidateAcquisitionPhase>();

/** Trusted operation labels only: messages, arguments and causes never enter job logs. */
export class CandidateAcquisitionError extends Error {
  constructor(readonly phase: CandidateAcquisitionPhase, cause: unknown) {
    super("trusted candidate acquisition failed", { cause });
  }
}
export async function acquisitionOperation<T>(phase: CandidateAcquisitionPhase, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const failure = (typeof error === "object" && error !== null) || typeof error === "function" ? error : new CandidateAcquisitionError(phase, error);
    if (!phases.has(failure)) phases.set(failure, phase);
    throw failure;
  }
}
export function writeAcquisitionDiagnostic(output: Writable, error: unknown, code: string | undefined): void {
  if (typeof error !== "object" || error === null) return;
  const phase = phases.get(error);
  if (phase === undefined) return;
  // The caller supplies only its closed mapping of known failure classes.
  output.write(JSON.stringify({ component: "candidate-acquisition", phase,
    code: code ?? "candidate-acquisition-failed" }) + "\n");
}
