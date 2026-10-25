import { executionCandidateLeaseLifetimeMilliseconds, executionCandidateLeaseMinimumRemainingMilliseconds } from "@slop-lab/dim-contracts-ci/execution";
import { expect, it } from "vitest";
import { executionCandidateCredential } from "../../../../packages/host/plugins/execution-worker/src/candidateLease.js";
it("refreshes only expiring trusted credentials and propagates changed-snapshot denial without retry", async () => {
  let now = 0, calls = 0, current = true;
  const get = executionCandidateCredential(async () => {
    calls++;
    if (!current) throw new Error("dependency head changed");
    return { username: `lease-${calls}`, password: "private", expiresAt: now + executionCandidateLeaseLifetimeMilliseconds };
  }, () => now);
  const signal = new AbortController().signal;
  expect((await get(signal)).username).toBe("lease-1");
  now = 59_999; expect((await get(signal)).username).toBe("lease-1");
  now = 60_000; expect((await get(signal)).username).toBe("lease-2");
  now = 120_000; current = false;
  await expect(get(signal)).rejects.toThrow("dependency head changed");
  expect(calls).toBe(3);
});
it("does not issue a new capability after cancellation", async () => {
  let calls = 0;
  const get = executionCandidateCredential(async () => { calls++; return { username: "reader", password: "private", expiresAt: 30_000 }; }, () => 0);
  const stop = new AbortController(); stop.abort();
  await expect(get(stop.signal)).rejects.toThrow(); expect(calls).toBe(0);
});

it("rejects a newly issued capability with too little time for a complete Git operation", async () => {
  const get = executionCandidateCredential(async () => ({ username: "reader", password: "private", expiresAt: executionCandidateLeaseMinimumRemainingMilliseconds }), () => 0);
  await expect(get(new AbortController().signal)).rejects.toThrow("insufficient remaining lifetime");
});
it("shares an in-flight refresh without extending the issued capability", async () => {
  let calls = 0;
  const get = executionCandidateCredential(async () => {
    calls++;
    await Promise.resolve();
    return { username: "reader", password: "private", expiresAt: executionCandidateLeaseLifetimeMilliseconds };
  }, () => 0);
  const signal = new AbortController().signal;
  const [first, second] = await Promise.all([get(signal), get(signal)]);
  expect(calls).toBe(1); expect(first).toBe(second); expect(first.expiresAt).toBe(120_000);
});
