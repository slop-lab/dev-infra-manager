import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const helper = pathToFileURL(new URL("../../../../core/scripts/publish-package-version.mjs", import.meta.url).pathname).href;

function resolveVersion(sourceVersion: string, localVersion?: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { publishPackageVersion } from ${JSON.stringify(helper)};
    process.stdout.write(publishPackageVersion(
      ${JSON.stringify(sourceVersion)}, ${JSON.stringify(localVersion)}
    ));
  `], { encoding: "utf8" });
}

describe("publish package version", () => {
  it("preserves release versions when no local version is requested", () => {
    expect(resolveVersion("0.9.0").stdout).toBe("0.9.0");
  });

  it.each([
    "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890-dirty"
  ])("accepts a valid local identity: %s", (identity) => {
    const localVersion = `0.9.0-local-${identity}`;
    expect(resolveVersion("0.9.0", localVersion).stdout).toBe(localVersion);
  });

  it.each([
    `0.9.0-local-${"a".repeat(6)}`,
    `0.9.0-local-${"a".repeat(7)}`,
    `0.9.0-local-${"a".repeat(40)}`,
    `0.9.0-local-${"a".repeat(41)}`,
    `0.9.0-local-${"a".repeat(63)}`,
    `0.9.0-local-${"a".repeat(65)}`,
    `0.9.0-local-${"A".repeat(64)}`,
    `0.9.0-local-${"a".repeat(63)}g`,
    `0.9.0-local- ${"a".repeat(64)}`,
    `0.9.0-local-${"a".repeat(64)} `,
    `0.9.0-local-${"a".repeat(64)}-dirty-dirty`,
    `0.9.0-local-${"a".repeat(64)}-dirty-extra`
  ])("rejects an invalid identity-shaped local version: %s", (invalid) => {
    const result = resolveVersion("0.9.0", invalid);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DIM_LOCAL_BUILD_VERSION");
  });

  it.each(["0.9.0", "0.8.0-local-abcdef1"])("rejects an invalid local version prefix: %s", (invalid) => {
    const result = resolveVersion("0.9.0", invalid);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DIM_LOCAL_BUILD_VERSION");
  });
});
