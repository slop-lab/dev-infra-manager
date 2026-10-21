import { expect, it } from "vitest";
import { executionCandidateCredential } from "../../../../packages/host/plugins/execution-worker/src/candidateLease.js";
it("refreshes only expiring trusted credentials and propagates changed-snapshot denial without retry", async () => {
  let now = 0, calls = 0, current = true;
  const get = executionCandidateCredential(async () => {
    calls++;
    if (!current) throw new Error("dependency head changed");
    return { username: `lease-${calls}`, password: "private", expiresAt: now + 30_000 };
  }, () => now);
  const signal = new AbortController().signal;
  expect((await get(signal)).username).toBe("lease-1");
  now = 28_000; expect((await get(signal)).username).toBe("lease-1");
  now = 29_500; expect((await get(signal)).username).toBe("lease-2");
  now = 60_000; current = false;
  await expect(get(signal)).rejects.toThrow("dependency head changed");
  expect(calls).toBe(3);
});
it("does not issue a new capability after cancellation", async () => {
  let calls = 0;
  const get = executionCandidateCredential(async () => { calls++; return { username: "reader", password: "private", expiresAt: 30_000 }; }, () => 0);
  const stop = new AbortController(); stop.abort();
  await expect(get(stop.signal)).rejects.toThrow(); expect(calls).toBe(0);
});
