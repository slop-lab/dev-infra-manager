import { describe, expect, it } from "vitest";
import { publishPackageVersion } from "../../../../core/scripts/publish-package-version.mjs";

describe("publish package version", () => {
  it("preserves release versions unless a validated local version is requested", () => {
    expect(publishPackageVersion("0.8.0", undefined)).toBe("0.8.0");
    expect(publishPackageVersion("0.8.0", "0.8.0-local-abcdef123456")).toBe(
      "0.8.0-local-abcdef123456"
    );
    expect(publishPackageVersion("0.8.0", "0.8.0-local-abcdef1-dirty")).toBe(
      "0.8.0-local-abcdef1-dirty"
    );
    expect(() => publishPackageVersion("0.8.0", "0.8.0"))
      .toThrow(/DIM_LOCAL_BUILD_VERSION/);
    expect(() => publishPackageVersion("0.8.0", "0.9.0-local-abcdef1"))
      .toThrow(/DIM_LOCAL_BUILD_VERSION/);
  });
});
