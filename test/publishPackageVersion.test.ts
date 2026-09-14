import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const helper = pathToFileURL(new URL("../../plugin-external-urls/scripts/publish-package-version.mjs", import.meta.url).pathname).href;

function resolveVersion(sourceVersion: string, localVersion?: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { publishPackageVersion } from ${JSON.stringify(helper)};
    process.stdout.write(publishPackageVersion(
      ${JSON.stringify(sourceVersion)}, ${JSON.stringify(localVersion)}
    ));
  `], { encoding: "utf8" });
}

describe("publish package version", () => {
  it("accepts only local versions derived from the tracked release version", () => {
    expect(resolveVersion("0.8.0").stdout).toBe("0.8.0");
    const aggregate = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    for (const suffix of ["", "-dirty"]) {
      const localVersion = `0.8.0-local-${aggregate}${suffix}`;
      expect(resolveVersion("0.8.0", localVersion).stdout).toBe(localVersion);
    }
    for (const invalid of [
      `0.8.0-local-${"a".repeat(6)}`,
      `0.8.0-local-${"a".repeat(7)}`,
      `0.8.0-local-${"a".repeat(40)}`,
      `0.8.0-local-${"a".repeat(63)}`,
      `0.8.0-local-${"a".repeat(65)}`,
      `0.8.0-local-${"A".repeat(64)}`,
      `0.8.0-local-${"a".repeat(64)}g`,
      "0.8.0-local- abcdef1",
      "0.8.0-local-abcdef1 ",
      "0.8.0-local--dirty-abcdef1",
      "0.8.0-local-abcdef1-dirty-dirty",
      "0.8.0-local-abcdef1-dirty-extra",
      "0.8.0",
      "latest",
      "0.9.0-local-abcdef1"
    ]) {
      const result = resolveVersion("0.8.0", invalid);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("DIM_LOCAL_BUILD_VERSION");
    }
  });
});
