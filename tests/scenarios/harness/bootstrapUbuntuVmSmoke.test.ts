import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";

const verificationRoot = new URL("../../../scripts/checks/", import.meta.url).pathname;
const driverPath = join(verificationRoot, "bootstrap-ubuntu-vm-smoke.bash");
const aggregatePath = join(verificationRoot, "kvm-guest-verification-smoke.bash");
const delegatePath = join(verificationRoot, "kvm-guest-group-delegate.bash");
const sourceHelperPath = join(verificationRoot, "lib", "bootstrap-ubuntu-vm-source.bash");
const guestHelperPath = join(verificationRoot, "lib", "bootstrap-ubuntu-vm-guest.bash");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("defines a pinned, bounded two-role fresh Ubuntu acceptance profile", async () => {
  const [driver, sourceHelper, guestHelper] = await Promise.all([
    readFile(driverPath, "utf8"),
    readFile(sourceHelperPath, "utf8"),
    readFile(guestHelperPath, "utf8")
  ]);

  const syntaxResults = [driverPath, sourceHelperPath, guestHelperPath]
    .map((path) => spawnSync("bash", ["-n", path]));

  for (const result of syntaxResults) assert.equal(result.status, 0);
  assert.match(driver, /release-20260926\/ubuntu-24\.04-server-cloudimg-amd64\.img/);
  assert.match(driver, /6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2/);
  assert.match(driver, /for role in ordinary control-qemu/);
  assert.match(driver, /BOOTSTRAP_CLEANUP_UNCERTAIN/);
  assert.match(driver, /fresh Ubuntu VM cleanup uncertain; preserved=/);
  assert.match(guestHelper, /-smp 2/);
  assert.match(guestHelper, /memory_mb=2048/);
  assert.match(guestHelper, /memory_mb=3072/);
  assert.match(guestHelper, /32G/);
  assert.match(guestHelper, /StrictHostKeyChecking=yes/);
  assert.match(guestHelper, /UserKnownHostsFile=/);
  assert.doesNotMatch(guestHelper, /StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/);
  assert.match(guestHelper, /first bootstrap login must exit 3/);
  assert.match(guestHelper, /0\\\.10\\\.0-local-\[0-9a-f\]\{64\}/);
  assert.match(guestHelper, /docker run --rm --runtime=sysbox-runc/);
  assert.match(guestHelper, /just verify native-idle-service-images && just verify installer-artifacts/);
  assert.match(guestHelper, /pnpm install --frozen-lockfile && just build-packages/);
  assert.match(guestHelper, /bash scripts\/examples\/verify-installed\.bash/);
  assert.match(sourceHelper, /schemaVersion/);
  assert.match(sourceHelper, /sourceSha/);
  assert.match(sourceHelper, /sourceTree/);
});

test("keeps legacy aggregate behavior and adds only the fixed input-gated stage", async () => {
  const [aggregate, delegate] = await Promise.all([
    readFile(aggregatePath, "utf8"),
    readFile(delegatePath, "utf8")
  ]);

  const hostRefusal = spawnSync("bash", [delegatePath, "bootstrap"], {
    cwd: verificationRoot,
    encoding: "utf8"
  });

  assert.equal(hostRefusal.status, 2);
  assert.match(hostRefusal.stderr, /disposable QEMU verification guest/);
  assert.match(aggregate, /\[\[ -d \/mnt\/dim-inputs\/bootstrap-source \|\| -L \/mnt\/dim-inputs\/bootstrap-source \]\]/);
  assert.doesNotMatch(aggregate, /\[\[ -e \/mnt\/dim-inputs\/bootstrap-source\/root\.bundle/);
  assert.match(aggregate, /verification_stage_register fresh-ubuntu-bootstrap/);
  assert.match(aggregate, /kvm-guest-group-delegate\.bash" bootstrap/);
  assert.match(delegate, /preflight\|run\|bootstrap/);
  assert.match(delegate, /bootstrap\) fresh_ubuntu_bootstrap/);
  assert.doesNotMatch(delegate, /exec[^\n]*"\$@"/);
  assert.doesNotMatch(delegate, /\b(?:chmod|chown|usermod|udev)\b/);
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
