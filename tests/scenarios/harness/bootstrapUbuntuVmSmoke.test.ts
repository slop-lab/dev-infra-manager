import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

const verificationRoot = new URL("../../../scripts/checks/", import.meta.url).pathname;
const driverPath = join(verificationRoot, "bootstrap-ubuntu-vm-smoke.bash");
const delegatePath = join(verificationRoot, "kvm-guest-group-delegate.bash");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("refuses the bootstrap stage outside a disposable QEMU verification guest", () => {
  const hostRefusal = spawnSync("bash", [delegatePath, "bootstrap"], {
    cwd: verificationRoot,
    encoding: "utf8"
  });

  assert.equal(hostRefusal.status, 2);
  assert.match(hostRefusal.stderr, /disposable QEMU verification guest/);
});

test("rejects incomplete protected input before QEMU or network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-bootstrap-vm-input-"));
  temporaryRoots.push(root);
  const bundle = join(root, "root.bundle");
  const manifest = join(root, "manifest.json");
  await writeFile(bundle, "not a bundle\n");
  await writeFile(manifest, JSON.stringify({
    schemaVersion: 1,
    sourceSha: "a".repeat(40)
  }));

  const result = spawnSync("bash", [driverPath,
    "--source-bundle", bundle,
    "--source-manifest", manifest
  ], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /manifest must contain only schemaVersion, sourceSha, and sourceTree/);
});

test("exposes only strict standalone source arguments", () => {
  const sourceSha = "a".repeat(40);
  const sourceTree = "b".repeat(40);

  const help = spawnSync("bash", [driverPath, "--help"], { encoding: "utf8" });
  const unknown = spawnSync("bash", [driverPath,
    "--source-bundle", "/tmp/missing.bundle",
    "--source-sha", sourceSha,
    "--source-tree", sourceTree,
    "--command", "id"
  ], { encoding: "utf8" });

  assert.equal(help.status, 0);
  assert.match(help.stdout, /--source-bundle BUNDLE --source-sha SHA --source-tree TREE/);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument: --command/);
});
