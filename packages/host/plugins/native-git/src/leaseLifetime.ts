/** The issuer starts the TTL after proof completion, so proof latency is not lease age.
 * Local reuse keeps a fixed transport margin; the service enforces actual expiry on every Git request.
 */
export type LeaseTiming = {
  readonly issuedAt: unknown;
  readonly expiresAt: unknown;
  readonly elapsed: number;
  readonly preIssueMilliseconds: unknown;
  readonly receivedAt: number;
};

export function localLeaseExpiry(input: LeaseTiming): number | undefined {
  if (typeof input.issuedAt !== "number" || !Number.isSafeInteger(input.issuedAt)
    || typeof input.expiresAt !== "number" || !Number.isSafeInteger(input.expiresAt)
    || !Number.isFinite(input.elapsed) || input.elapsed < 0
    || typeof input.preIssueMilliseconds !== "number" || !Number.isSafeInteger(input.preIssueMilliseconds)
    || input.preIssueMilliseconds < 0) return;
  const duration = input.expiresAt - input.issuedAt;
  if (duration <= 0 || duration > 30_000) return;
  const totalElapsed = Math.ceil(input.elapsed);
  if (!Number.isSafeInteger(totalElapsed) || input.preIssueMilliseconds > totalElapsed) return;
  const remaining = duration - (totalElapsed - input.preIssueMilliseconds) - 1_000;
  if (remaining <= 0) return;
  return input.receivedAt + remaining;
}
