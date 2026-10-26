import { describe, expect, it } from "vitest";
import { ownedRuntimeNames, compareUnrelatedResources, ownedResourceKeys } from "./ownership.js";

describe("ownedRuntimeNames", () => {
  it("Given a workspace UUID, when names are derived, then every resource is identity scoped", () => {
    const names = ownedRuntimeNames("3f35fd22-bcb8-4848-992a-4f51f8c0651e");
    expect(ownedResourceKeys(names).size).toBe(6);
    expect(names.container).toMatch(/^dim-workspace-[a-f0-9]{24}$/);
    expect(names.checkout).toBe(`${names.container}-checkout`);
  });
});

describe("compareUnrelatedResources", () => {
  it("Given an owned resource set, when only those resources disappear, then unrelated resources are unchanged", () => {
    const before = new Set(["container:other", "volume:owned-home", "network:owned"]);
    const after = new Set(["container:other"]);
    const owned = new Set(["volume:owned-home", "network:owned"]);
    expect(compareUnrelatedResources(before, after, owned)).toEqual([]);
  });

  it("Given an unrelated resource disappears, when snapshots are compared, then the mutation is reported", () => {
    const before = new Set(["container:other", "volume:owned-home"]);
    const after = new Set<string>();
    const owned = new Set(["volume:owned-home"]);
    expect(compareUnrelatedResources(before, after, owned)).toEqual(["container:other"]);
  });

  it("Given an unrelated resource appears, when snapshots are compared, then the mutation is reported", () => {
    const before = new Set(["container:other"]);
    const after = new Set(["container:other", "network:leaked"]);
    const owned = new Set<string>();
    expect(compareUnrelatedResources(before, after, owned)).toEqual(["network:leaked"]);
  });
});
