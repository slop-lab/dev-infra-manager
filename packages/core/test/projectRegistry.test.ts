import { describe, expect, it } from "vitest";
import { normalizeRootRef, projectNamespace } from "../src/projectRegistry.js";

describe("project registry", () => {
  it("derives reserved managed namespaces", () => {
    expect(projectNamespace("acme")).toBe("dim-acme");
    expect(() => projectNamespace("../acme")).toThrow(/project name/);
  });

  it("normalizes root branches to full refs", () => {
    expect(normalizeRootRef("main")).toBe("refs/heads/main");
    expect(normalizeRootRef("refs/heads/release/next")).toBe("refs/heads/release/next");
    expect(() => normalizeRootRef("refs/tags/v1")).toThrow(/root ref/);
    expect(() => normalizeRootRef("bad..ref")).toThrow(/root ref/);
  });
});
