import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const builtPackage = path.resolve(import.meta.dirname, "../../../../core/packages/controller-proxy/dist");
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((item) => item())));

describe("shipped controller-proxy runtime closure", () => {
  it("executes the development-service helper outside the source checkout", async () => {
    // Given: only the package directory copied into a workspace image.
    const root = await mkdtemp(path.join(tmpdir(), "dim-controller-proxy-closure-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const installedPackage = path.join(root, "controller-proxy");
    await cp(builtPackage, installedPackage, { recursive: true });

    // When: Node loads and executes the helper without repository node_modules ancestors.
    const result = spawnSync(process.execPath, [
      path.join(installedPackage, "development-service-cli.js"),
      "workspace-subdomain",
      "--workspace",
      "work",
      "--service",
      "opencode"
    ], { encoding: "utf8", cwd: root });

    // Then: the complete runtime closure is present and the helper succeeds.
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toMatch(/^work-[0-9a-f]{16}--opencode\n$/);
  });
});
