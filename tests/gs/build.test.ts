import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("builds and executes an isolated GS package with no DIM configuration or build tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "gs-independent-build-")), owner = join(root, "gs"), pkg = join(owner, "fixture");
  const execute = promisify(execFile), require = createRequire(import.meta.url);
  try {
    await mkdir(join(pkg, "src"), { recursive: true }); await mkdir(join(pkg, "node_modules/@types"), { recursive: true });
    for (const file of ["build-package.ts", "tsconfig.base.json", "LICENSE"]) {
      await copyFile(new URL(`../../packages/gs/${file}`, import.meta.url), join(owner, file));
    }
    await symlink(dirname(require.resolve("typescript/package.json")), join(pkg, "node_modules/typescript"));
    await symlink(dirname(require.resolve("@types/node/package.json")), join(pkg, "node_modules/@types/node"));
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@slop-lab/gs-build-fixture", version: "0.10.0", private: true,
      type: "module", license: "MIT", main: "./dist/index.js", types: "./dist/index.d.ts", scripts: { build: "node ../build-package.ts" },
      publishConfig: { access: "public", directory: "dist" },
      exports: { ".": { source: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" } },
      dependencies: { "@slop-lab/gs-diff": "workspace:0.10.0" } }));
    await writeFile(join(pkg, "tsconfig.build.json"), JSON.stringify({ extends: "../tsconfig.base.json",
      compilerOptions: { rootDir: "src", outDir: "dist", declaration: true, customConditions: [] }, include: ["src/**/*.ts"] }));
    await writeFile(join(pkg, "src/index.ts"), "export const answer: number = 42;\n");
    await writeFile(join(pkg, "README.md"), "# Isolated GS build fixture\n");
    await execute(process.execPath, [join(owner, "build-package.ts")], { cwd: pkg,
      env: { ...process.env, DIM_LOCAL_BUILD_VERSION: "9.9.9", GS_BUILD_VERSION: "0.10.0-test.gs" }, timeout: 30_000 });
    const manifest: unknown = JSON.parse(await readFile(join(pkg, "dist/package.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "@slop-lab/gs-build-fixture", version: "0.10.0-test.gs",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } }, dependencies: { "@slop-lab/gs-diff": "0.10.0-test.gs" } });
    expect(manifest).not.toHaveProperty("private"); expect(manifest).not.toHaveProperty("scripts");
    expect(manifest).not.toHaveProperty("publishConfig.directory");
    const executed = await execute(process.execPath, ["--input-type=module", "-e",
      `import {answer} from ${JSON.stringify(pathToFileURL(join(pkg, "dist/index.js")).href)}; console.log(answer);`], { cwd: root });
    expect(executed.stdout.trim()).toBe("42");
    expect(await readFile(join(pkg, "dist/LICENSE"), "utf8")).toBe(await readFile(join(owner, "LICENSE"), "utf8"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
