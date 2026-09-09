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
  it("preserves release versions unless a validated local version is requested", () => {
    expect(resolveVersion("0.8.0").stdout).toBe("0.8.0");
    expect(resolveVersion("0.8.0", "0.8.0-local-abcdef123456").stdout)
      .toBe("0.8.0-local-abcdef123456");
    expect(resolveVersion("0.8.0", "0.8.0-local-abcdef1-dirty").stdout)
      .toBe("0.8.0-local-abcdef1-dirty");
    for (const invalid of ["0.8.0", "0.9.0-local-abcdef1"]) {
      const result = resolveVersion("0.8.0", invalid);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("DIM_LOCAL_BUILD_VERSION");
    }
  });
});
