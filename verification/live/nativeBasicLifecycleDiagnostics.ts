const maximumDiagnosticLength = 1_024;

export function nativeLifecycleFailure(
  primary: unknown,
  cleanupFailures: readonly unknown[]
): AggregateError {
  const failures = primary === undefined ? [...cleanupFailures] : [primary, ...cleanupFailures];
  const cause = primary ?? cleanupFailures[0];
  const summaries = cleanupFailures.map((failure) => diagnosticSummary(failure)).join(", ");
  const detail = primary === undefined
    ? `cleanup=${summaries}`
    : `primary=${diagnosticSummary(primary)}; cleanup=${summaries}`;
  const message = `native lifecycle cleanup is uncertain; ${detail}`.slice(0, maximumDiagnosticLength);
  return new AggregateError(failures, message, { cause });
}

function diagnosticSummary(failure: unknown): string {
  if (!(failure instanceof Error)) return "unknown failure";
  return `${failure.name}: ${failure.message}`
    .replace(/:\/\/[^/@\s]+@/gu, "://[redacted]@")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]");
}
