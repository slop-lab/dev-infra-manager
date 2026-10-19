type Credential = { readonly username: string; readonly password: string; readonly expiresAt: number };
/** Refresh only an expiring read capability; failed authority checks are never retried or widened. */
export function executionCandidateCredential(load: (signal: AbortSignal) => Promise<Credential>, now = Date.now) {
  let credential: Credential | undefined;
  let pending: Promise<Credential> | undefined;
  return async (signal: AbortSignal): Promise<Credential> => {
    signal.throwIfAborted();
    if (credential !== undefined && credential.expiresAt - now() > 1000) return credential;
    pending ??= load(signal);
    try {
      const refreshed = await pending;
      signal.throwIfAborted();
      if (!Number.isSafeInteger(refreshed.expiresAt) || refreshed.expiresAt <= now()) throw new Error("execution candidate lease is already expired");
      credential = refreshed;
      return refreshed;
    } finally { pending = undefined; }
  };
}
