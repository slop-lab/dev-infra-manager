import { ExecutionLeaseLostError, ExecutionServiceUnavailableError } from "./client.js";
import { NativeHostVerificationError } from "./candidate.js";
import { NativeGitCandidateReadError } from "./nativeGitCandidateReadAuthority.js";
import { NativeGitProcessError } from "./nativeGitCandidateProcess.js";
import { CandidateObjectError } from "./nativeGitCandidateObjects.js";

export function candidateFailureCode(error: unknown): string | undefined {
  if (error instanceof NativeGitProcessError) {
    switch (error.code) {
      case "auth-denied": return "candidate-read-auth-denied";
      case "transport": return "candidate-read-transport-failed";
      case "timeout": return "candidate-read-timeout";
      case "aborted": return "candidate-read-aborted";
      case "output-limit": return "candidate-read-output-limit";
      case "process-unavailable": return "candidate-read-process-unavailable";
      case "failed": return "candidate-read-failed";
    }
  }
  if (error instanceof ExecutionLeaseLostError) return "candidate-read-stale";
  if (error instanceof ExecutionServiceUnavailableError) return error.code === "timeout" ? "candidate-read-timeout" : "candidate-read-unavailable";
  if (error instanceof NativeHostVerificationError || error instanceof NativeGitCandidateReadError
    || error instanceof CandidateObjectError) return "candidate-read-rejected";
  return undefined;
}
