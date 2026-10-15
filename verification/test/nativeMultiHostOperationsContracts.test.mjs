import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";

const exec = promisify(execFile);
const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonLibrary = join(verificationRoot, "scripts", "lib", "native-multi-host-operations-common.bash");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("accepts distinct valid prepared workspace image IDs across independently prepared nodes", async () => {
  const result = await nodeSeparation(identity("control", "c", "e"), identity("ordinary", "c", "f"));

  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test.each([
  ["source commit", identity("control", "c", "e"), identityWith("ordinary", "commit", "9".repeat(40)), /commit/],
  ["aggregate lock digest", identity("control", "c", "e"), identityWith("ordinary", "aggregateLockSha256", "9".repeat(64)), /aggregateLockSha256/],
  ["source package digest", identity("control", "c", "e"), identity("ordinary", "f", "f"), /packageSha256/],
  ["control image ID", identity("control", "c", "invalid"), identity("ordinary", "c", "f"), /preparedImageId/],
  ["ordinary image ID", identity("control", "c", "e"), identity("ordinary", "c", "invalid"), /preparedImageId/]
])("rejects mismatched or malformed prepared identity: %s", async (_label, control, ordinary, diagnostic) => {
  const result = await execFailure("bash", ["-c", separationDriver, "bash", commonLibrary, control, ordinary]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, diagnostic);
});

test("executes the QEMU idle SSH payload against the real host schema and fixed capacity paths", async () => {
  const fixture = await qemuFixture([{ capacity: "integration" }, { capacity: "release.cpu" }]);

  await execQemuProbe(fixture);

  await writeFile(join(fixture.stateRoot, "integration", "journal.json"), "{}\n");
  const residue = await execQemuProbeFailure(fixture);
  assert.notEqual(residue.code, 0);
});

test.each([
  ["missing capacity", [{ runnerBaseImage: image("1"), jobBaseImage: image("2") }]],
  ["unsafe capacity", [{ capacity: "../escape" }]],
  ["duplicate capacity", [{ capacity: "integration" }, { capacity: "integration" }]]
])("QEMU idle SSH payload rejects %s without process-substitution success", async (_label, capacities) => {
  const fixture = await qemuFixture(capacities);

  const result = await execQemuProbeFailure(fixture);

  assert.notEqual(result.code, 0);
});

test("QEMU idle SSH payload rejects a configured host ID mismatch", async () => {
  const fixture = await qemuFixture([{ capacity: "integration" }]);

  const result = await execQemuProbeFailure({ ...fixture, expectedHost: "other-host" });

  assert.notEqual(result.code, 0);
});

const separationDriver = `set -euo pipefail; source "$1"; declare -A OPS_CONFIG=([QEMU_HOST_ID]=qemu [ORDINARY_HOST_ID]=ordinary); ops_assert_node_separation "$2" "$3"`;

function identity(machine, packageDigit, imageDigit) {
  const preparedImageId = imageDigit === "invalid" ? "sha256:not-a-digest" : `sha256:${imageDigit.repeat(64)}`;
  return JSON.stringify({ machineId: machine, bootId: `boot-${machine}`, dockerId: `docker-${machine}`,
    stateIdentity: `state-${machine}`, commit: "a".repeat(40), dimVersion: "0.9.0",
    aggregateLockSha256: "b".repeat(64), packageSha256: packageDigit.repeat(64),
    preparedImageRef: image("d"), preparedImageId });
}

function identityWith(machine, field, value) {
  return JSON.stringify({ ...JSON.parse(identity(machine, "c", "f")), [field]: value });
}

async function nodeSeparation(control, ordinary) {
  return await exec("bash", ["-c", separationDriver, "bash", commonLibrary, control, ordinary]);
}

async function qemuFixture(capacities) {
  const root = await mkdtemp(join(tmpdir(), "dim-native-operations-qemu-contract-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const stateRoot = join(root, "state");
  const config = join(root, "qemu-host.json");
  await mkdir(bin);
  await mkdir(stateRoot);
  await writeFile(join(bin, "docker"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const completeCapacities = capacities.map((capacity, index) => ({
    runnerBaseImage: image(String(index + 1)), jobBaseImage: image(String(index + 3)),
    cpus: 2, memoryBytes: 536870912, supervisorMemoryBytes: 805306368,
    pids: 128, timeoutSeconds: 300, outputBytes: 1048576, ...capacity
  }));
  await writeFile(config, JSON.stringify({ schemaVersion: 1, hostId: "qemu-a", generationId: "a".repeat(64),
    gitExecutable: "/usr/bin/git", scheduler: { transport: "loopback-http", endpoint: "http://127.0.0.1:9010",
      serviceId: "qemu-main", hostToken: "A".repeat(43) },
    nativeGit: { transport: "loopback-http", endpoint: "http://127.0.0.1:9020", serviceId: "native-main" },
    capacities: completeCapacities }));
  for (const capacity of completeCapacities) {
    if (typeof capacity.capacity === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(capacity.capacity)) {
      await mkdir(join(stateRoot, capacity.capacity), { recursive: true });
    }
  }
  return { config, stateRoot, bin, expectedHost: "qemu-a" };
}

async function execQemuProbe(fixture) {
  return await exec("bash", ["-c", qemuProbeDriver, "bash", commonLibrary, fixture.config, fixture.expectedHost], {
    env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, OPS_TEST_QEMU_STATE_ROOT: fixture.stateRoot }
  });
}

async function execQemuProbeFailure(fixture) {
  try { return await execQemuProbe(fixture); } catch (error) {
    if (error instanceof Error && "code" in error && "stderr" in error) return error;
    throw error;
  }
}

const qemuProbeDriver = String.raw`
set -euo pipefail
source "$1"
ops_ssh() {
  local target="$1" payload
  shift
  payload="$(cat)"
  payload="\${payload//\/var\/lib\/dim-native-qemu-host/$OPS_TEST_QEMU_STATE_ROOT}"
  "$@" <<<"$payload"
}
ops_assert_qemu_idle control "$2" "$3"
`;

function image(digit) {
  return `registry.example/image@sha256:${digit.repeat(64)}`;
}

async function execFailure(file, args) {
  try { await exec(file, args); } catch (error) {
    if (error instanceof Error && "code" in error && "stderr" in error) return error;
    throw error;
  }
  throw new Error("command unexpectedly succeeded");
}
