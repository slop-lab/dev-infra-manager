import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import { parseNativeQemuConnection } from "../../core/packages/core/src/nativeQemuConnection.ts";
import { parseNativeQemuSchedulerConfig } from "../../core/packages/core/src/nativeQemuSchedulerConfig.ts";
import { parseNativeRootCiHostConfig } from "../../core/packages/core/src/nativeRootCiHostConfig.ts";

const exec = promisify(execFile);
const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(verificationRoot, "scripts", "native-cutover-clean-host.bash");
const runLibrary = join(verificationRoot, "scripts", "lib", "native-cutover-clean-host-run.bash");
const evidenceLibrary = join(verificationRoot, "scripts", "lib", "native-cutover-clean-host-evidence.bash");
const example = join(verificationRoot, "native-cutover-clean-host.conf.example");
const runbook = join(verificationRoot, "native-cutover-host.md");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("prints the fixed packaged happy-path smoke command plan without operator input", async () => {
  // Given / When
  const result = await exec("bash", [script, "--print-command-plan"]);

  // Then
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "preflight:ssh-source-package-file-runtime-node-separation",
    "install:just-install-local",
    "control-plane:dim-installer-install-control-plane",
    "project:bootstrap-native-root,create-ready",
    "workspace:create-schema9,proposal-push-denials",
    "ci:native-root-admit-host,native-qemu-scheduler-admit-host",
    "review:create,inspect,promote-denied,approve,promote-cas",
    "cleanup:workspace-discard,started-services-stop,owned-claim-residue",
    "evidence:credential-free-manifest,atomic-smoke-marker"
  ]);
  assert.equal(result.stderr, "");
});

test("rejects an unsafe operator config before creating evidence", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "dim-native-cutover-test-"));
  temporaryRoots.push(root);
  const config = join(root, "operator.conf");
  const evidence = join(root, "evidence");
  await writeFile(config, `EVIDENCE_DIR=${evidence}\n`, { mode: 0o644 });
  await chmod(config, 0o644);

  // When
  const result = await execFailure("bash", [script, "--preflight-only", config]);

  // Then
  assert.equal(result.code, 2);
  assert.match(result.stderr, /caller-owned mode-0600 regular file/);
  await assert.rejects(readFile(evidence));
});

test("contains no simulated runtime fallback or credential-bearing remote argv", async () => {
  // Given / When
  const source = await readFile(script, "utf8");

  // Then
  assert.doesNotMatch(source, /--privileged|qemu-system[^\n]*-accel[ =]tcg|docker[^\n]*--runtime[ =]runc/);
  assert.doesNotMatch(source, /ssh[^\n]*(PASSWORD|TOKEN|CREDENTIAL)/i);
  assert.match(source, /sysbox-runc/);
  assert.match(source, /\/dev\/kvm/);
  assert.match(source, /type=image/);
});

test("rejects protected verification-socket use before SSH", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "dim-native-cutover-test-"));
  temporaryRoots.push(root);
  const config = join(root, "operator.conf");
  const source = (await readFile(example, "utf8"))
    .replace("PROTECTED_QEMU_MODE=unused", "PROTECTED_QEMU_MODE=service")
    .replace("EVIDENCE_DIR=/srv/dim-evidence/native-cutover", `EVIDENCE_DIR=${join(root, "evidence")}`);
  await writeFile(config, source, { mode: 0o600 });

  // When
  const result = await execFailure("bash", [script, "--preflight-only", config]);

  // Then
  assert.equal(result.code, 2);
  assert.match(result.stderr, /PROTECTED_QEMU_MODE=unused/);
  assert.doesNotMatch(result.stderr, /ssh:/i);
});

test("packages the command through the verification recipe", async () => {
  // Given / When
  const recipe = await readFile(join(verificationRoot, "verify.just"), "utf8");

  // Then
  assert.match(recipe, /native-cutover-clean-host-smoke config:/);
  assert.match(recipe, /native-cutover-clean-host\.bash "\{\{config\}\}"/);
  assert.doesNotMatch(recipe, /^native-cutover-clean-host config:/m);
});

test("publishes only a bounded atomic smoke result", async () => {
  // Given / When
  const source = await readFile(script, "utf8");

  // Then
  assert.doesNotMatch(source, /ACCEPTED|outcome:\s*"accepted"|accepted review=/);
  assert.match(source, /SMOKE-PASSED/);
  assert.match(source, /scope:\s*"real-installed-multi-node-dual-kind-happy-path"/);
  assert.match(source, /notVerified:/);
  assert.match(source, /mv -- "\$smoke_result_temporary" "\$evidence\/SMOKE-PASSED"/);
});

test("runbook host fixtures satisfy the current strict production parsers", async () => {
  // Given
  const source = await readFile(runbook, "utf8");
  const ordinary = documentedJson(source, "ordinary-host");
  const qemuHost = documentedJson(source, "qemu-host");
  const qemuScheduler = documentedJson(source, "qemu-scheduler");

  // When
  const parsedOrdinary = parseNativeRootCiHostConfig(ordinary);
  const parsedQemuHost = parseNativeQemuConnection(qemuHost, "qemu-a");
  const parsedQemuScheduler = parseNativeQemuSchedulerConfig(qemuScheduler);

  // Then
  assert.deepEqual(Object.keys(parsedOrdinary.nativeGit), ["transport", "endpoint", "serviceId"]);
  assert.deepEqual(Object.keys(parsedQemuHost.nativeGit), ["transport", "endpoint", "serviceId"]);
  assert.deepEqual(Object.keys(parsedQemuScheduler.nativeGit), [
    "endpoint", "serviceId", "identity", "attemptIssuer", "candidateReader", "resultReporter"
  ]);
});

test("arms exit cleanup before starting the first CI service", async () => {
  // Given
  const driver = `
set -euo pipefail
source "$1"
declare -A CUTOVER_CONFIG=(
  [CONTROL_SSH]=control [ORDINARY_SSH]=ordinary [PROJECT_ID]=project
  [ORDINARY_ADMISSION_CONFIG]=/ordinary-admission [QEMU_SCHEDULER_CONFIG]=/qemu-scheduler
  [QEMU_SCHEDULER_UNIT]=qemu-scheduler.service [QEMU_HOST_UNIT]=qemu-host.service
  [ORDINARY_UNIT]=ordinary.service
)
CUTOVER_STARTED_SERVICES=0
calls=0
cutover_ssh() {
  calls=$((calls + 1))
  [[ "$calls" -lt 4 ]]
}
trap 'printf "%s\\n" "$CUTOVER_STARTED_SERVICES"' EXIT
cutover_admit_and_start_ci
`;

  // When
  const result = await execFailure("bash", ["-c", driver, "bash", runLibrary]);

  // Then
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "1\n");
});

test("records the images selected by delivered terminal descriptors", async () => {
  // Given
  const terminal = JSON.stringify({
    ordinary: { event: { payload: { descriptor: {
      runnerBaseImage: `registry.example/ordinary-runner@sha256:${"1".repeat(64)}`,
      jobImage: `registry.example/ordinary-job@sha256:${"2".repeat(64)}`
    } } } },
    qemu: { event: { payload: { descriptor: {
      runnerBaseImage: `registry.example/qemu-runner@sha256:${"3".repeat(64)}`,
      jobImage: `registry.example/qemu-job@sha256:${"4".repeat(64)}`
    } } } }
  });
  const driver = `
set -euo pipefail
source "$1"
declare -A CUTOVER_CONFIG=(
  [CONTROL_SSH]=control [ORDINARY_SSH]=ordinary [CONTROL_INSTALL_CONFIG]=/install
  [QEMU_HOST_CONFIG]=/qemu [NATIVE_GIT_CONTAINER]=native [ORDINARY_CI_CONTAINER]=ordinary-ci
  [ORDINARY_HOST_CONFIG]=/ordinary
)
cutover_ssh() {
  target="$1"; shift
  if [[ "$target" == control ]]; then
    [[ "$8" == "registry.example/qemu-runner@sha256:${"3".repeat(64)}" ]]
    [[ "$9" == "registry.example/qemu-job@sha256:${"4".repeat(64)}" ]]
    printf '%s\\n' '{"controlPlane":[],"qemu":{"runnerBaseImage":"qemu-runner","jobImage":"qemu-job","imageIds":[]},"runningContainerImageIds":[]}'
  else
    [[ "$5" == "registry.example/ordinary-runner@sha256:${"1".repeat(64)}" ]]
    [[ "$6" == "registry.example/ordinary-job@sha256:${"2".repeat(64)}" ]]
    printf '%s\\n' '{"hostId":"ordinary","runnerBaseImage":"ordinary-runner","jobImage":"ordinary-job","imageIds":[]}'
  fi
}
cutover_capture_image_evidence "$2"
`;

  // When
  const result = await exec("bash", ["-c", driver, "bash", evidenceLibrary, terminal]);

  // Then
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    controlQemu: {
      controlPlane: [],
      qemu: { runnerBaseImage: "qemu-runner", jobImage: "qemu-job", imageIds: [] },
      runningContainerImageIds: []
    },
    ordinary: { hostId: "ordinary", runnerBaseImage: "ordinary-runner", jobImage: "ordinary-job", imageIds: [] }
  });
});

async function execFailure(file, args) {
  try {
    await exec(file, args);
  } catch (error) {
    if (error instanceof Error && "code" in error && "stderr" in error) return error;
    throw error;
  }
  throw new Error("command unexpectedly succeeded");
}

function documentedJson(source, name) {
  const marker = `<!-- native-cutover-smoke-fixture:${name} -->`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name} fixture marker`);
  const fenced = source.slice(start + marker.length).match(/\s*```json\n([\s\S]*?)\n```/);
  assert.notEqual(fenced, null, `missing ${name} JSON fixture`);
  return JSON.parse(fenced[1]);
}
