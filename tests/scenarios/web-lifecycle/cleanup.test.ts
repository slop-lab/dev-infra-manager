import { describe, expect, it } from "vitest";
import { selectCleanupIdentity } from "./cleanup.js";

const workspace = (name: string, id: string) => ({
  id, name, phase: "error", resources: { cpuCount: "1", memory: "2g", pidsLimit: "512" }
});

describe("selectCleanupIdentity", () => {
  it("Given a partial private record, when no ID was observed, then cleanup discovers its UUID", () => {
    expect(selectCleanupIdentity([workspace("owned", "11111111-1111-4111-8111-111111111111")], "owned", undefined))
      .toBe("11111111-1111-4111-8111-111111111111");
  });

  it("Given a reused name, when the observed UUID differs, then cleanup refuses mutation", () => {
    expect(() => selectCleanupIdentity([workspace("owned", "22222222-2222-4222-8222-222222222222")], "owned", "11111111-1111-4111-8111-111111111111"))
      .toThrow(/identity changed/);
  });

  it("Given unexpected private state, when cleanup discovers records, then it refuses mutation", () => {
    expect(() => selectCleanupIdentity([workspace("other", "33333333-3333-4333-8333-333333333333")], "owned", undefined))
      .toThrow(/unexpected workspace/);
  });
});
