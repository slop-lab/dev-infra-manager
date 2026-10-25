import { executionCandidateLeaseMinimumRemainingMilliseconds } from "@slop-lab/dim-contracts-ci/execution";

type Credential = { readonly username: string; readonly password: string; readonly expiresAt: number };
/** Refresh only an expiring read capability; failed authority checks are never retried or widened. */
export function executionCandidateCredential(load: (signal: AbortSignal) => Promise<Credential>, now = Date.now) {
  let credential: Credential | undefined;
  let pending: Promise<Credential> | undefined;
  return async (signal: AbortSignal): Promise<Credential> => {
    signal.throwIfAborted();
    if (credential !== undefined && credential.expiresAt - now() > executionCandidateLeaseMinimumRemainingMilliseconds) return credential;
    pending ??= load(signal);
    try {
      const refreshed = await pending;
      signal.throwIfAborted();
      if (!Number.isSafeInteger(refreshed.expiresAt) || refreshed.expiresAt - now() <= executionCandidateLeaseMinimumRemainingMilliseconds) throw new Error("execution candidate lease has insufficient remaining lifetime");
      credential = refreshed;
      return refreshed;
    } finally { pending = undefined; }
  };
}
