import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const smokePath = join(verificationRoot, "scripts", "native-qemu-guest-mechanics-tcg-smoke.bash");
const recipesPath = join(verificationRoot, "verify.just");
const productionLauncherPath = join(
  verificationRoot,
  "..",
  "core",
  "packages",
  "core",
  "src",
  "native-qemu-runner-assets",
  "dim-native-qemu-run"
);

test("keeps TCG guest-mechanics verification separate from production KVM acceptance", async () => {
  // Given
  const [smoke, recipes, productionLauncher] = await Promise.all([
    readFile(smokePath, "utf8"),
    readFile(recipesPath, "utf8"),
    readFile(productionLauncherPath, "utf8")
  ]);

  // When
  const syntax = spawnSync("bash", ["-n", smokePath]);

  // Then
  assert.equal(syntax.status, 0);
  assert.match(smoke, /q35,accel=tcg/);
  assert.match(smoke, /guest-mechanics-not-KVM-acceptance/);
  assert.match(smoke, /docker export/);
  assert.match(smoke, /docker cp/);
  assert.match(smoke, /type=volume,source=.*guest_root_volume/);
  assert.doesNotMatch(smoke, /type=bind/);
  assert.doesNotMatch(smoke, /\/dev\/kvm|\/usr\/local\/bin\/dim-native-qemu-run/);
  assert.match(recipes, /^native-qemu-guest-mechanics-tcg:/m);
  assert.match(productionLauncher, /q35,accel=kvm/);
  assert.doesNotMatch(productionLauncher, /accel=tcg/);
});
