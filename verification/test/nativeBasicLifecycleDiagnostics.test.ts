import { describe, expect, it } from "vitest";
import { nativeLifecycleFailure } from "../live/nativeBasicLifecycleDiagnostics.js";

describe("native basic lifecycle diagnostics", () => {
  it("preserves primary and cleanup failures with bounded redacted output", () => {
    const primary = new TypeError(
      `checkout failed token=${"a".repeat(43)} at https://operator:password@native.invalid/root`
    );
    const cleanup = new Error(`container cleanup failed authorization=Bearer ${"b".repeat(43)}`);

    const failure = nativeLifecycleFailure(primary, [cleanup]);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.cause).toBe(primary);
    expect(failure.errors).toEqual([primary, cleanup]);
    expect(failure.message).toContain("primary=TypeError: checkout failed");
    expect(failure.message).toContain("cleanup=Error: container cleanup failed");
    expect(failure.message).not.toContain("a".repeat(43));
    expect(failure.message).not.toContain("b".repeat(43));
    expect(failure.message).not.toContain("operator:password");
    expect(failure.message.length).toBeLessThanOrEqual(1_024);
  });

  it("reports cleanup-only failures without inventing a primary error", () => {
    const cleanup = new Error("image removal failed");

    const failure = nativeLifecycleFailure(undefined, [cleanup]);

    expect(failure.cause).toBe(cleanup);
    expect(failure.errors).toEqual([cleanup]);
    expect(failure.message).toBe("native lifecycle cleanup is uncertain; cleanup=Error: image removal failed");
  });
});
