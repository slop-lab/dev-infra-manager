import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const livePath = join(verificationRoot, "live", "nativeBasicLifecycleLive.test.ts");
const driverPath = join(verificationRoot, "scripts", "native-basic-lifecycle-live.bash");
const aggregatePath = join(verificationRoot, "scripts", "kvm-guest-verification-smoke.bash");
const recipesPath = join(verificationRoot, "verify.just");

test("packages the real native basic lifecycle as bounded same-host mechanics", async () => {
  const [live, driver, aggregate, recipes] = await Promise.all([
    readFile(livePath, "utf8"),
    readFile(driverPath, "utf8"),
    readFile(aggregatePath, "utf8"),
    readFile(recipesPath, "utf8")
  ]);

  assert.match(live, /nativeFixture\(\)/);
  assert.match(live, /hostMirrorProvider/);
  assert.match(live, /registerPlugins\(\[hostMirrorPlugin\]\)/);
  assert.match(live, /ensureRegistryCache/);
  assert.match(live, /ensureAptCache/);
  assert.match(live, /readHostMirrorOwnership/);
  assert.match(live, /writeHostMirrorOwnership/);
  assert.match(live, /buildWorkspaceImage/);
  assert.match(live, /configuredDimController/);
  assert.match(live, /createWorkspace/);
  assert.match(live, /stopWorkspace/);
  assert.match(live, /startWorkspace/);
  assert.match(live, /restartWorkspace/);
  assert.match(live, /updateWorkspace/);
  assert.match(live, /refs\/heads\/proposals\/\$\{workspace\.workspaceId\}/);
  assert.match(live, /refs\/heads\/main/);
  assert.match(live, /discardWorkspace/);
  assert.match(live, /writeCleanupUncertaintySentinel/);
  assert.ok(live.indexOf("await writeCleanupUncertaintySentinel()")
    < live.indexOf("throw nativeLifecycleFailure(primaryFailure, failures)"));
  assert.doesNotMatch(live, /operator review approve|operator review promote|ACCEPTED/);
  assert.match(driver, /DIM_NATIVE_BASIC_LIFECYCLE_CLEANUP_SENTINEL/);
  assert.match(driver, /status=125/);
  assert.doesNotMatch(driver, /smoke-ok|PASS|ACCEPTED/);
  assert.match(recipes, /^native-basic-lifecycle:/m);
  assert.match(recipes, /native-basic-lifecycle-live\.bash/);
  assert.doesNotMatch(recipes, /DIM_NATIVE_BASIC_LIFECYCLE_CONFIG|native-basic-lifecycle\.conf/);
  assert.match(aggregate, /test\/nativeBasicLifecycleSmoke\.test\.mjs/);
  assert.match(aggregate, /just verify native-basic-lifecycle/);
  assert.match(aggregate, /verification_stage_register native-basic-lifecycle native_basic_lifecycle "source-ready docker-ready sysbox-ready"/);
  assert.doesNotMatch(aggregate, /verification_stage_register native-basic-lifecycle[^\n]*(?:installed-services|qemu)/);
});

test("maps only armed lifecycle cleanup uncertainty to exit 125", async () => {
  const root = await mkdtemp("/tmp/dim-native-basic-driver-");
  const pnpm = join(root, "pnpm");
  try {
    for (const scenario of [
      { body: "exit 0", status: 0 },
      { body: "exit 1", status: 1 },
      { body: 'printf uncertain >"$DIM_NATIVE_BASIC_LIFECYCLE_CLEANUP_SENTINEL"; exit 1', status: 125 }
    ]) {
      await writeFile(pnpm, `#!/usr/bin/env bash\n${scenario.body}\n`, { mode: 0o700 });
      await chmod(pnpm, 0o700);
      const result = spawnSync("bash", [driverPath], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` }
      });
      assert.equal(result.status, scenario.status, result.stderr);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
