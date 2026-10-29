import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const packageNames = [
  "repository-contracts",
  "review-contracts",
  "repository",
  "repository-service",
  "review",
  "merge-policy",
] as const;

it("builds the standalone review and merge package graph outside DIM", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "gs-review-source-owner-"));
  const owner = join(root, "gs");
  const execute = promisify(execFile);
  const require = createRequire(import.meta.url);

  try {
    await mkdir(owner, { recursive: true });
    for (const name of ["build-package.ts", "tsconfig.base.json", "LICENSE"]) {
      await cp(new URL(`../../../packages/gs/${name}`, import.meta.url), join(owner, name));
    }
    for (const name of packageNames) {
      await cp(new URL(`../../../packages/gs/${name}`, import.meta.url), join(owner, name), {
        recursive: true,
        filter: (source) => !source.split("/").some((part) => part === "node_modules" || part === "dist"),
      });
    }
    await linkDependencies(owner, require);

    // When
    for (const name of packageNames) {
      await execute(process.execPath, [join(owner, "build-package.ts")], {
        cwd: join(owner, name),
        env: { ...process.env, NODE_PATH: "", GS_BUILD_VERSION: "0.10.0-p2-source" },
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    }

    // Then
    for (const name of packageNames) {
      const manifest: unknown = JSON.parse(await readFile(join(owner, name, "dist/package.json"), "utf8"));
      expect(manifest).toMatchObject({ version: "0.10.0-p2-source" });
      if (!manifest || typeof manifest !== "object") throw new Error("built GS manifest is invalid");
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
        const dependencies = Reflect.get(manifest, field);
        if (dependencies === undefined) continue;
        if (!dependencies || typeof dependencies !== "object") throw new Error("built dependency map is invalid");
        expect(Object.keys(dependencies).some((dependency) => dependency.startsWith("@slop-lab/dim-"))).toBe(false);
      }
    }
    expect(await readFile(join(owner, "review", "dist/LICENSE"), "utf8"))
      .toBe(await readFile(join(owner, "LICENSE"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

async function linkDependencies(owner: string, require: NodeJS.Require): Promise<void> {
  const externals = [
    ["typescript", require.resolve("typescript/package.json")],
    ["@types/node", require.resolve("@types/node/package.json")],
    ["undici-types", require.resolve("undici-types/package.json")],
    ["zod", require.resolve("zod/package.json")],
    ["jsonc-parser", require.resolve("jsonc-parser/package.json")],
  ] as const;
  for (const name of packageNames) {
    const modules = join(owner, name, "node_modules");
    await mkdir(join(modules, "@slop-lab"), { recursive: true });
    await mkdir(join(modules, "@types"), { recursive: true });
    for (const [dependency, manifest] of externals) {
      const destination = join(modules, dependency);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(dirname(manifest), destination, "dir");
    }
    for (const dependency of packageNames) {
      if (dependency === name) continue;
      await symlink(join(owner, dependency), join(modules, "@slop-lab", `gs-${dependency}`), "dir");
    }
  }
}
