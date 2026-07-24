import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";

describe("config", () => {
  it("normalizes relative state paths to absolute paths", () => {
    const config = normalizeConfig(DEFAULT_CONFIG);
    expect(config.stateRoot.startsWith("/")).toBe(true);
    expect(config.resourceProfiles.default?.diskBytes).toBe(20 * 1024 ** 3);
    expect(config.storageBackend.kind).toBe("loopback");
    expect(config.agent.runtimeBackend.kind).toBe("sysbox");
  });

  it("rejects missing required agent fields", () => {
    const invalid = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
    invalid.agent = { image: "x" };
    expect(() => normalizeConfig(invalid)).toThrow(/agent.runtime/);
  });

  it("requires managed Git protected refs", () => {
    const invalid = structuredClone(DEFAULT_CONFIG);
    invalid.managedGitHost.protectedRefs = [];
    expect(() => normalizeConfig(invalid)).toThrow(/protectedRefs/);
  });

  it("keeps legacy agent runtime configs readable", () => {
    const legacy = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
    delete legacy.storageBackend;
    const agent = legacy.agent as Record<string, unknown>;
    delete agent.runtimeBackend;

    const config = normalizeConfig(legacy);
    expect(config.storageBackend.kind).toBe("loopback");
    expect(config.agent.runtimeBackend).toEqual({ kind: "sysbox", dockerRuntime: "sysbox-runc" });
  });
});
