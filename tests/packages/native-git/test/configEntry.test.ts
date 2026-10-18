import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { idleNativeConfig } from "./bundleConfigFixture.js";

it("configuration parsing and host preparation do not load the SQLite authority runtime", () => {
  const setup = new URL("../../../../core/packages/managed/src/controlPlaneSetup.ts", import.meta.url).href;
  const cli = new URL("../../../../core/packages/managed/src/cli/managed-cli.ts", import.meta.url).href;
  const pair = new URL("../../../../core/packages/managed/src/controlPlaneServicePair.ts", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "node:sqlite") throw new Error("configuration loaded the SQLite authority runtime");
      return next(specifier, context);
    } });
    const { parseNativeGitBundleConfig, NativeGitBundleConfigError } = await import("@slop-lab/dim-native-git/config");
    const parsed = parseNativeGitBundleConfig(JSON.parse(process.env.DIM_TEST_CONFIG));
    let rejected = false;
    try { parseNativeGitBundleConfig({ ...parsed, schemaVersion: -1 }); }
    catch (error) { rejected = error instanceof NativeGitBundleConfigError; }
    await import(${JSON.stringify(setup)});
    await import(${JSON.stringify(pair)});
    await import(${JSON.stringify(cli)});
    console.log(JSON.stringify({ serviceId: parsed.serviceId, rejected }));
  `], {
    cwd: fileURLToPath(new URL("../../../../core/packages/native-git/", import.meta.url)),
    env: { ...process.env, DIM_TEST_CONFIG: JSON.stringify(idleNativeConfig()) }, encoding: "utf8"
  });
  expect(JSON.parse(output)).toEqual({ serviceId: "native-main", rejected: true });
});
