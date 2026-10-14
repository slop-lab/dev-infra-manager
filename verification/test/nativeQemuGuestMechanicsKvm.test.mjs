import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const smokePath = join(verificationRoot, "scripts", "native-qemu-guest-mechanics-kvm-smoke.bash");
const aggregatePath = join(verificationRoot, "scripts", "kvm-guest-verification-smoke.bash");
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

test("runs real KVM guest mechanics without claiming independent acceptance", async () => {
  // Given
  const [smoke, aggregate, recipes, productionLauncher] = await Promise.all([
    readFile(smokePath, "utf8"),
    readFile(aggregatePath, "utf8"),
    readFile(recipesPath, "utf8"),
    readFile(productionLauncherPath, "utf8")
  ]);

  // When
  const syntax = spawnSync("bash", ["-n", smokePath]);

  // Then
  assert.equal(syntax.status, 0);
  assert.match(smoke, /q35,accel=kvm/);
  assert.match(smoke, /same-host-native-mechanics-not-independent-acceptance/);
  assert.match(smoke, /docker export/);
  assert.match(smoke, /docker cp/);
  assert.match(smoke, /type=volume,source=.*guest_root_volume/);
  assert.doesNotMatch(smoke, /type=bind/);
  assert.match(smoke, /--device \/dev\/kvm/);
  assert.match(smoke, /timeout --signal=TERM --kill-after=15s 180s[\s\\]*docker run/);
  assert.match(smoke, /cleanup_resources \|\| exit 125/);
  assert.match(smoke, /resource_label="dim\.verification\.native-qemu-kvm=\$suffix"/);
  assert.match(smoke, /refusing to (?:replace|use) pre-existing/);
  assert.ok(smoke.indexOf("cleanup_resources || exit 125") < smoke.indexOf("native-qemu-guest-mechanics-kvm-smoke-ok"));
  assert.doesNotMatch(smoke, /\/usr\/local\/bin\/dim-native-qemu-run/);
  assert.doesNotMatch(smoke, new RegExp(["DIM_NATIVE_QEMU", "TCG_EVIDENCE_ROOT"].join("_")));
  assert.match(recipes, /^native-qemu-guest-mechanics-kvm:/m);
  assert.match(recipes, /^full-development:/m);
  assert.match(recipes, /full-development:[\s\S]*kvm-guest-verification-smoke\.bash/);
  assert.match(aggregate, /verification_stage_register qemu-kvm-mechanics qemu_mechanics "docker-ready kvm-ready"/);
  assert.doesNotMatch(aggregate, /verification_stage_register qemu-kvm-mechanics[^\n]*(?:sysbox|ordinary|native-contracts|installed-services)/);
  assert.match(aggregate, /stat -Lc 'kind=%F mode=%a uid=%u gid=%g' -- \/dev\/kvm/);
  assert.match(aggregate, /id -u/);
  assert.match(aggregate, /id -g/);
  assert.match(aggregate, /id -Gn/);
  assert.match(aggregate, /\/proc\/cpuinfo/);
  assert.match(aggregate, /vmx\|svm/);
  assert.match(aggregate, /kvm-ready diagnostic/);
  assert.match(smoke, /"acceleration":"kvm"/);
  assert.doesNotMatch(smoke, /accel=tcg|"acceleration":"tcg"/);
  assert.match(productionLauncher, /q35,accel=kvm/);
  assert.doesNotMatch(productionLauncher, /accel=tcg/);
});
