import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("checks KVM launch scripts and refuses guest delegation outside its disposable guest", () => {
  for (const script of [
    join(root, "scripts/native-qemu-guest-mechanics-kvm-smoke.bash"),
    join(root, "scripts/kvm-guest-group-delegate.bash"),
    join(root, "../core/packages/managed/src/native-qemu-runner-assets/dim-native-qemu-run")
  ]) {
    const result = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const delegate = join(root, "scripts/kvm-guest-group-delegate.bash");
  for (const operation of ["preflight", "/bin/sh"]) {
    const result = spawnSync("bash", [delegate, operation], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /disposable QEMU verification guest/);
  }
});
