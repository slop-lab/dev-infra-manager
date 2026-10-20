/** Issuer wall time bounds its TTL; whole-request monotonic time bounds local reuse.
 * The service remains authoritative for actual credential expiry on every Git request.
 */
export function localLeaseExpiry(
  issuedAt: unknown,
  expiresAt: unknown,
  elapsed: number,
  receivedAt: number
): number | undefined {
  if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt)
    || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)
    || !Number.isFinite(elapsed) || elapsed < 0) return;
  const duration = expiresAt - issuedAt;
  if (duration <= 0 || duration > 30_000) return;
  const remaining = duration - Math.ceil(elapsed);
  if (remaining <= 0) return;
  return receivedAt + remaining;
}
