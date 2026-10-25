import { ExecutionLeaseLostError, ExecutionServiceUnavailableError } from "./client.js";
import { NativeHostVerificationError } from "./candidate.js";
import { NativeGitCandidateReadError } from "./nativeGitCandidateReadAuthority.js";
import { CandidateObjectError } from "./nativeGitCandidateObjects.js";

export function candidateFailureCode(error: unknown): string | undefined {
  if (error instanceof ExecutionLeaseLostError) return "candidate-read-stale";
  if (error instanceof ExecutionServiceUnavailableError) return error.code === "timeout" ? "candidate-read-timeout" : "candidate-read-unavailable";
  if (error instanceof NativeHostVerificationError || error instanceof NativeGitCandidateReadError
    || error instanceof CandidateObjectError) return "candidate-read-rejected";
  return undefined;
}
