import { describe, expect, it } from "vitest";
import { CoalescedAsyncOperations } from "../../../../packages/control-plane/plugins/git-ci/src/coalesced-async-operations.js";
import { PlanPathAttestations } from "../../../../packages/control-plane/plugins/git-ci/src/plan-path-attestations.js";
import { BoundedProjectionCache } from "../../../../packages/control-plane/plugins/git-ci/src/plan-projection-cache.js";
import {
  GitCiPlanFileVersionError,
  type GitCiPlanFileVersion
} from "../../../../packages/control-plane/plugins/git-ci/src/plan-file-version.js";

describe("Git CI plan cache domains", () => {
  it("keeps projection entries within entry and encoded-byte limits", () => {
    // Given
    const entryBounded = new BoundedProjectionCache<string, string>(2, 100);
    const byteBounded = new BoundedProjectionCache<string, string>(10, 8);

    // When
    for (const cache of [entryBounded, byteBounded]) {
      cache.set("first", "attachment", "aa");
      cache.set("second", "attachment", "bb");
      cache.set("third", "attachment", "cc");
    }

    // Then
    expect(entryBounded.get("first")).toBeUndefined();
    expect(entryBounded.entryCount).toBe(2);
    expect(byteBounded.get("first")).toBeUndefined();
    expect(byteBounded.entryCount).toBe(2);
    expect(byteBounded.encodedBytes).toBe(8);
  });

  it("does not reinsert an entry touched after eviction", () => {
    // Given
    const cache = new BoundedProjectionCache<string, string>(1, 16);
    cache.set("first", "attachment", "aa");
    const evicted = cache.get("first");
    if (evicted === undefined) throw new CacheFixtureError("expected cached projection");
    cache.set("second", "attachment", "bb");

    // When
    cache.touch("first", evicted);

    // Then
    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("second")?.value).toBe("bb");
    expect(cache.entryCount).toBe(1);
  });

  it("coalesces an identical operation until its result settles", async () => {
    // Given
    const operations = new CoalescedAsyncOperations<string, string>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const operation = async (): Promise<string> => {
      calls += 1;
      await release.promise;
      return "projection";
    };

    // When
    const first = operations.run("plan", operation);
    const second = operations.run("plan", operation);
    release.resolve();

    // Then
    await expect(Promise.all([first, second])).resolves.toEqual(["projection", "projection"]);
    expect(calls).toBe(1);
  });

  it("fails closed at attestation capacity without forgetting known paths", () => {
    // Given
    const attestations = new PlanPathAttestations(1, 1_024);
    const knownVersion = planVersion(1n);
    attestations.attest("known", knownVersion);

    // When / Then
    expect(() => attestations.attest("new", planVersion(2n)))
      .toThrowError(new GitCiPlanFileVersionError("Git CI plan path attestation capacity is exhausted"));
    expect(attestations.expected("known")).toBe(knownVersion);
    expect(attestations.expected("new")).toBeUndefined();
  });
});

function planVersion(ino: bigint): GitCiPlanFileVersion {
  return {
    dev: 1n,
    ino,
    size: 2n,
    mtimeNs: 3n,
    ctimeNs: 4n,
    uid: 5n,
    mode: 0o100600n,
    nlink: 1n
  };
}

class CacheFixtureError extends Error {
  readonly name = "CacheFixtureError";
}
