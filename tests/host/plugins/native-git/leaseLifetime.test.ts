import { expect, it } from "vitest";
import { localLeaseExpiry } from "../../../../packages/host/plugins/native-git/src/leaseLifetime.js";
it("retains a fresh issuer lease after a slow proof without relying on wall-clock alignment", () => {
  expect(localLeaseExpiry({ issuedAt: 100, expiresAt: 30_100, elapsed: 29_200, preIssueMilliseconds: 29_000, receivedAt: 1_000 })).toBe(29_800);
  expect(localLeaseExpiry({ issuedAt: 100, expiresAt: 30_100, elapsed: 10_000, preIssueMilliseconds: 0, receivedAt: 1_000 })).toBe(20_000);
  expect(localLeaseExpiry({ issuedAt: 100, expiresAt: 30_100, elapsed: 29_000, preIssueMilliseconds: 0, receivedAt: 1_000 })).toBeUndefined();
  expect(localLeaseExpiry({ issuedAt: 100, expiresAt: 30_101, elapsed: 1, preIssueMilliseconds: 0, receivedAt: 1_000 })).toBeUndefined();
  expect(localLeaseExpiry({ issuedAt: 100, expiresAt: 100, elapsed: 0, preIssueMilliseconds: 0, receivedAt: 1_000 })).toBeUndefined();
  expect(localLeaseExpiry({ issuedAt: 100, expiresAt: 30_100, elapsed: 1, preIssueMilliseconds: 2, receivedAt: 1_000 })).toBeUndefined();
  expect(localLeaseExpiry({ issuedAt: 100, expiresAt: 30_100, elapsed: 1, preIssueMilliseconds: -1, receivedAt: 1_000 })).toBeUndefined();
  expect(localLeaseExpiry({ issuedAt: 100, expiresAt: 30_100, elapsed: 1, preIssueMilliseconds: 0.5, receivedAt: 1_000 })).toBeUndefined();
  expect(localLeaseExpiry({ issuedAt: undefined, expiresAt: 30_100, elapsed: 1, preIssueMilliseconds: 0, receivedAt: 1_000 })).toBeUndefined();
});
