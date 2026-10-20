import { expect, it } from "vitest";
import { localLeaseExpiry } from "../../../../packages/host/plugins/native-git/src/leaseLifetime.js";
it("rejects invalid or transit-exhausted issuer durations without relying on wall-clock alignment", () => {
  expect(localLeaseExpiry(100, 30_100, 30_000, 1_000)).toBeUndefined();
  expect(localLeaseExpiry(100, 30_101, 1, 1_000)).toBeUndefined();
  expect(localLeaseExpiry(100, 100, 0, 1_000)).toBeUndefined();
  expect(localLeaseExpiry(100, 99, 0, 1_000)).toBeUndefined();
  expect(localLeaseExpiry(undefined, 30_100, 1, 1_000)).toBeUndefined();
  expect(localLeaseExpiry(100, 30_100, 0.5, 1_000)).toBe(30_999);
});
