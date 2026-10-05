import { afterEach, describe, expect, it, vi } from "vitest";
import { executeNativeHostClaim, NativeHostLeaseError } from "../../../../core/packages/core/src/nativeOrdinaryExecutor.js";
import { dependencies, execution, ExecutorRunner } from "./nativeOrdinaryExecutorFixture.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("native ordinary executor limits and lease ownership", () => {
  it("caps output, aborts execution, cleans up, then reports output-limit evidence", async () => {
    // Given
    const runner = new ExecutorRunner();
    runner.output = "x".repeat(2_000);
    const input = execution();
    const bounded = { ...input, claim: { ...input.claim, descriptor: {
      ...input.claim.descriptor, bounds: { ...input.claim.descriptor.bounds, outputBytes: "16" }
    } } };
    bounded.claim.descriptorDigest = (await import("../../../../core/packages/core/src/nativeOrdinaryAuthorityProtocol.js"))
      .nativeDescriptorDigest(bounded.claim.descriptor);

    // When
    const completed = await executeNativeHostClaim(dependencies(runner), bounded);

    // Then
    expect(completed.terminalEvent.payload.completion).toEqual({ kind: "output-limit-exceeded" });
    expect(completed.stdout.length + completed.stderr.length).toBe(16);
    expect(completed.terminalEvent.payload.stdout.truncated).toBe(true);
  });

  it("times out a running job and reports only after owned cleanup", async () => {
    // Given
    vi.useFakeTimers();
    const runner = new ExecutorRunner();
    runner.waitForAbort = true;
    const input = execution();
    const bounded = { ...input, claim: { ...input.claim, descriptor: {
      ...input.claim.descriptor, bounds: { ...input.claim.descriptor.bounds, wallClockSeconds: "1" }
    } } };
    bounded.claim.descriptorDigest = (await import("../../../../core/packages/core/src/nativeOrdinaryAuthorityProtocol.js"))
      .nativeDescriptorDigest(bounded.claim.descriptor);
    const running = executeNativeHostClaim(dependencies(runner), bounded);

    // When
    await vi.advanceTimersByTimeAsync(1_001);
    const completed = await running;

    // Then
    expect(completed.terminalEvent.payload.completion).toEqual({ kind: "timed-out" });
    expect(runner.calls.at(-1)?.args[0]).toBe("container");
    vi.useRealTimers();
  });

  it("recovers instead of reporting after uncertain lease renewal", async () => {
    // Given
    vi.useFakeTimers();
    const runner = new ExecutorRunner();
    runner.waitForAbort = true;
    let renewals = 0;
    const reports: unknown[] = [];
    const recoveries: unknown[] = [];
    const fixture = {
      ...dependencies(runner),
      async renewClaim(request: Parameters<ReturnType<typeof dependencies>["renewClaim"]>[0]) {
        renewals += 1;
        if (renewals > 1) throw new Error("lease uncertain");
        return { schemaVersion: 1 as const, serviceId: "ordinary-main", requestId: request.requestId, claimId: request.claimId,
          leaseExpiresAt: Date.now() + 2, leaseDurationMilliseconds: 2 };
      },
      async reportResult(request: unknown) { reports.push(request); },
      async recoverClaim(request: unknown) { recoveries.push(request); }
    };
    const running = executeNativeHostClaim(fixture, execution());

    // When
    await vi.advanceTimersByTimeAsync(2);
    const completed = await running;

    // Then
    expect(completed.disposition).toBe("recovered");
    expect(completed.terminalEvent.payload.completion).toEqual({ kind: "lease-lost" });
    expect(reports).toEqual([]);
    expect(recoveries).toHaveLength(1);
    vi.useRealTimers();
  });

  it("rejects a delayed initial renewal before candidate reads or Docker work", async () => {
    // Given
    vi.useFakeTimers();
    const runner = new ExecutorRunner();
    const baseline = dependencies(runner);
    const createReadAuthority = vi.fn(baseline.createReadAuthority);
    const reportResult = vi.fn();
    const recoverClaim = vi.fn();
    let renewalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { renewalStarted = resolve; });
    const fixture = {
      ...baseline,
      createReadAuthority,
      async renewClaim(request: Parameters<ReturnType<typeof dependencies>["renewClaim"]>[0]) {
        renewalStarted?.();
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        return { schemaVersion: 1 as const, serviceId: "ordinary-main", requestId: request.requestId, claimId: request.claimId,
          leaseExpiresAt: Date.now() - 1, leaseDurationMilliseconds: 10 };
      },
      reportResult,
      recoverClaim
    };
    const running = executeNativeHostClaim(fixture, execution());

    // When
    await started;
    await vi.advanceTimersByTimeAsync(25);

    // Then
    await expect(running).rejects.toBeInstanceOf(NativeHostLeaseError);
    expect(createReadAuthority).not.toHaveBeenCalled();
    expect(runner.calls.some((call) => call.args[0] === "pull" || call.args[0] === "run")).toBe(false);
    expect(reportResult).not.toHaveBeenCalled();
    expect(recoverClaim).toHaveBeenCalledOnce();
  });

  it("aborts and removes an in-progress container at the current lease deadline while renewal is pending", async () => {
    // Given
    vi.useFakeTimers();
    const runner = new ExecutorRunner();
    runner.waitForAbort = true;
    const cancellation = new AbortController();
    const reports: unknown[] = [];
    const recoveries: unknown[] = [];
    let renewals = 0;
    let releaseRenewal: (() => void) | undefined;
    let waitStarted: (() => void) | undefined;
    let renewalStarted: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { waitStarted = resolve; });
    const renewing = new Promise<void>((resolve) => { renewalStarted = resolve; });
    let removed: (() => void) | undefined;
    const removal = new Promise<boolean>((resolve) => { removed = () => resolve(true); });
    runner.onWait = () => waitStarted?.();
    const fixture = {
      ...dependencies(runner),
      async renewClaim(request: Parameters<ReturnType<typeof dependencies>["renewClaim"]>[0], signal: AbortSignal) {
        renewals += 1;
        if (renewals === 1) {
          return { schemaVersion: 1 as const, serviceId: "ordinary-main", requestId: request.requestId, claimId: request.claimId,
            leaseExpiresAt: Date.now() + 10, leaseDurationMilliseconds: 10 };
        }
        renewalStarted?.();
        return new Promise<Awaited<ReturnType<ReturnType<typeof dependencies>["renewClaim"]>>>((resolve, reject) => {
          releaseRenewal = () => resolve({ schemaVersion: 1, serviceId: "ordinary-main", requestId: request.requestId,
            claimId: request.claimId, leaseExpiresAt: Date.now() + 10, leaseDurationMilliseconds: 10 });
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      async reportResult(request: unknown) { reports.push(request); },
      async recoverClaim(request: unknown) { recoveries.push(request); removed?.(); }
    };
    const running = executeNativeHostClaim(fixture, { ...execution(), signal: cancellation.signal });

    // When
    await waiting;
    await vi.advanceTimersByTimeAsync(5);
    await renewing;
    await vi.advanceTimersByTimeAsync(5);
    const removalDeadline = new Promise<boolean>((resolve) => setImmediate(() => resolve(false)));
    const removedAtDeadline = await Promise.race([removal, removalDeadline]);
    releaseRenewal?.();
    cancellation.abort();
    await vi.advanceTimersByTimeAsync(1);
    const completed = await running.then((result) => result, (error: unknown) => error);

    // Then
    expect(removedAtDeadline).toBe(true);
    expect(completed).toMatchObject({ disposition: "recovered", terminalEvent: { payload: { completion: { kind: "lease-lost" } } } });
    expect(reports).toEqual([]);
    expect(recoveries).toHaveLength(1);
  });

  it("reports after a fast periodic renewal extends the request-start deadline", async () => {
    // Given
    vi.useFakeTimers();
    const runner = new ExecutorRunner();
    let finishWait: (() => void) | undefined;
    let waitStarted: (() => void) | undefined;
    let renewalStarted: (() => void) | undefined;
    runner.waitUntil = new Promise<void>((resolve) => { finishWait = resolve; });
    runner.onWait = () => waitStarted?.();
    const waiting = new Promise<void>((resolve) => { waitStarted = resolve; });
    const renewing = new Promise<void>((resolve) => { renewalStarted = resolve; });
    let renewals = 0;
    const reports: unknown[] = [];
    const fixture = {
      ...dependencies(runner),
      async renewClaim(request: Parameters<ReturnType<typeof dependencies>["renewClaim"]>[0]) {
        renewals += 1;
        if (renewals === 2) renewalStarted?.();
        return { schemaVersion: 1 as const, serviceId: "ordinary-main", requestId: request.requestId, claimId: request.claimId,
          leaseExpiresAt: Date.now() + 10, leaseDurationMilliseconds: 10 };
      },
      async reportResult(request: unknown) { reports.push(request); }
    };
    const running = executeNativeHostClaim(fixture, execution());

    // When
    await waiting;
    await vi.advanceTimersByTimeAsync(5);
    await renewing;
    finishWait?.();
    const completed = await running;

    // Then
    expect(renewals).toBe(2);
    expect(completed.disposition).toBe("reported");
    expect(reports).toHaveLength(1);
  });

  it("retains an uncertain lease failure when its fenced recovery also fails", async () => {
    // Given
    vi.useFakeTimers();
    const runner = new ExecutorRunner();
    runner.waitForAbort = true;
    const leaseFailure = new Error("lease uncertain");
    const recoveryFailure = new Error("recovery unavailable");
    let renewals = 0;
    const fixture = {
      ...dependencies(runner),
      async renewClaim(request: Parameters<ReturnType<typeof dependencies>["renewClaim"]>[0]) {
        renewals += 1;
        if (renewals > 1) throw leaseFailure;
        return { schemaVersion: 1 as const, serviceId: "ordinary-main", requestId: request.requestId, claimId: request.claimId,
          leaseExpiresAt: Date.now() + 2, leaseDurationMilliseconds: 2 };
      },
      async recoverClaim() { throw recoveryFailure; }
    };
    const running = executeNativeHostClaim(fixture, execution());

    // When
    await vi.advanceTimersByTimeAsync(2);

    // Then
    await expect(running).rejects.toMatchObject({ cause: leaseFailure, recoveryError: recoveryFailure });
    vi.useRealTimers();
  });

  it("classifies lease loss during result submission as lease loss", async () => {
    // Given
    vi.useFakeTimers();
    const runner = new ExecutorRunner();
    const leaseFailure = new Error("lease uncertain");
    let renewals = 0;
    let reports = 0;
    const recoveries: unknown[] = [];
    const fixture = {
      ...dependencies(runner),
      async renewClaim(request: Parameters<ReturnType<typeof dependencies>["renewClaim"]>[0]) {
        renewals += 1;
        if (renewals > 1) throw leaseFailure;
        return { schemaVersion: 1 as const, serviceId: "ordinary-main", requestId: request.requestId, claimId: request.claimId,
          leaseExpiresAt: Date.now() + 1_000, leaseDurationMilliseconds: 1_000 };
      },
      async reportResult(_request: unknown, signal: AbortSignal) {
        reports += 1;
        if (reports === 1) {
          const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          await vi.advanceTimersByTimeAsync(500);
          await aborted;
        }
        signal.throwIfAborted();
      },
      async recoverClaim(request: unknown) { recoveries.push(request); }
    };

    // When
    const completed = await executeNativeHostClaim(fixture, execution());

    // Then
    expect(completed.disposition).toBe("recovered");
    expect(completed.terminalEvent.payload.completion).toEqual({ kind: "lease-lost" });
    expect(reports).toBeGreaterThan(0);
    expect(recoveries).toHaveLength(1);
    vi.useRealTimers();
  });
});
