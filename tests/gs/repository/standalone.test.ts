import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("builds and runs real Git HTTP outside DIM with only the extracted package and declared dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "gs-standalone-")), owner = join(root, "gs"), pkg = join(owner, "repository");
  const execute = promisify(execFile);
  try {
    await mkdir(owner, { recursive: true });
    for (const name of ["build-package.ts", "tsconfig.base.json", "LICENSE"]) await cp(new URL(`../../../packages/gs/${name}`, import.meta.url), join(owner, name));
    await cp(new URL("../../../packages/gs/repository", import.meta.url), pkg, { recursive: true,
      filter: (source) => !source.split("/").some((part) => part === "node_modules" || part === "dist") });
    const require = createRequire(import.meta.url), nodeTypes = require.resolve("@types/node/package.json");
    const packages = [
      ["typescript", require.resolve("typescript/package.json")], ["@types/node", nodeTypes],
      ["undici-types", createRequire(nodeTypes).resolve("undici-types/package.json")], ["zod", require.resolve("zod/package.json")]
    ];
    for (const [name, manifest] of packages) {
      if (!name || !manifest) throw new Error("declared standalone dependency missing");
      const destination = join(pkg, "node_modules", name); await mkdir(dirname(destination), { recursive: true });
      await cp(dirname(manifest), destination, { recursive: true });
    }
    const home = join(root, "home"); await mkdir(home);
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), NODE_OPTIONS: "", NODE_PATH: "", GS_BUILD_VERSION: "0.10.0-standalone" };
    await execute(process.execPath, [join(owner, "build-package.ts")], { cwd: pkg, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const driver = new URL("./standalone-driver.ts", import.meta.url).pathname;
    const result = await execute(process.execPath, [driver, join(pkg, "dist/index.js"), join(root, "runtime")], { cwd: root, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
    const report: unknown = JSON.parse(result.stdout);
    expect(report).toMatchObject({ foreignStatus: 404, tamperedHookStatus: 503, replacedExecutableStatus: 503 });
    if (!report || typeof report !== "object" || !("initial" in report) || !("candidate" in report) || !("protectedHead" in report)) throw new Error("standalone report missing actual ref evidence");
    expect(report.initial).not.toBe(report.candidate); expect(report.protectedHead).toBe(report.initial);
    await expect(readFile(join(root, "runtime/storage/state-format.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
