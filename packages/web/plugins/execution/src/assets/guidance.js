// @ts-check
/** @typedef {import('@slop-lab/dim-contracts-ci/query').ExecutionSummary['admission']} Admission */
/** @typedef {NonNullable<import('@slop-lab/dim-contracts-ci/query').ExecutionSummary['completion']>} Completion */

/** @param {Admission} admission */
export function admissionGuidance(admission) {
  if (!admission) return "";
  if (admission.phase === "authorize") {
    if (admission.code === "timeout") return "Git authorization timed out. Check Git service load and reconnect this controller to the current generation before retrying.";
    if (admission.code === "unavailable") return "Git authorization is unavailable. Check the Git service and reconnect this controller to the current generation before retrying.";
    return "Git authorization evidence is stale. Reconnect this controller to the current generation before retrying.";
  }
  if (admission.code === "timeout") return "Reading the candidate Git proof timed out. Check Git proof load, then retry.";
  if (admission.code === "unavailable") return "The candidate Git proof is unavailable. Check repository access and Git service load, then retry.";
  return "The candidate Git proof is stale. Resolve a fresh review for the current candidate before retrying.";
}

/** @param {Completion} completion */
export function completionGuidance(completion) {
  if (completion.kind === "executor-failure" && "code" in completion) {
    if (completion.code === "candidate-read-timeout") return "Execution infrastructure timed out reading the candidate. Check Git proof load, then retry.";
    if (completion.code === "candidate-read-stale") return "Execution infrastructure found stale candidate evidence. Resolve a fresh review before retrying.";
    return "Execution infrastructure failed before a guest result was available. Inspect worker capacity and retry.";
  }
  if (completion.kind === "exited" && "exitCode" in completion) return completion.exitCode === 0 ? "Guest command completed successfully." : `Guest command exited with code ${completion.exitCode}. Inspect the captured guest logs before retrying.`;
  if (completion.kind === "signaled" && "signal" in completion) return `Guest command ended from signal ${completion.signal}. Inspect the captured guest logs before retrying.`;
  if (completion.kind === "timed-out") return "Guest command exceeded its execution deadline.";
  if (completion.kind === "output-limit-exceeded") return "Guest command exceeded the configured output limit.";
  if (completion.kind === "lease-lost") return "Worker ownership was lost before completion. Inspect worker capacity and retry.";
  return "Execution was cancelled.";
}
