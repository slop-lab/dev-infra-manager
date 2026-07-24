import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";

describe("config", () => {
  it("normalizes relative state paths to absolute paths", () => {
    const config = normalizeConfig(DEFAULT_CONFIG);
    expect(config.stateRoot.startsWith("/")).toBe(true);
    expect(config.secretRuntime.repo).toBe("trusted-runtime");
  });

  it("requires managed Git protected refs", () => {
    const invalid = structuredClone(DEFAULT_CONFIG);
    invalid.managedGitHost.protectedRefs = [];
    expect(() => normalizeConfig(invalid)).toThrow(/protectedRefs/);
  });

});
