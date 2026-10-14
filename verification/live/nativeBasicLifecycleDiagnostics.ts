const maximumDiagnosticLength = 1_024;
const maximumCommandOutputLength = 384;

type LifecycleCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

class NativeLifecycleCommandError extends Error {
  readonly name = "NativeLifecycleCommandError";
}

export function nativeLifecycleCommandFailure(
  action: string,
  result: LifecycleCommandResult
): NativeLifecycleCommandError {
  const stdout = sanitized(result.stdout).slice(0, maximumCommandOutputLength);
  const stderr = sanitized(result.stderr).slice(0, maximumCommandOutputLength);
  return new NativeLifecycleCommandError(
    `${action} failed with exit code ${result.exitCode}; stdout=${stdout}; stderr=${stderr}`
  );
}

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
  return `${failure.name}: ${sanitized(failure.message)}`;
}

function sanitized(value: string): string {
  return value
    .replace(/:\/\/[^/@\s]+@/gu, "://[redacted]@")
    .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]");
}
