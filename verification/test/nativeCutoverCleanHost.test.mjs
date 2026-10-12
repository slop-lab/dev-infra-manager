import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import { parseNativeOrdinaryBundleConfig } from "../../core/packages/core/src/nativeOrdinaryBundleConfig.ts";
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
    "workspace:create-schema9,ready-before-ci",
    "ci:start-global-ordinary-host,qemu-scheduler-health,qemu-host",
    "proposal:push-denials,automatic-envelope2-events3-queue",
    "review:resolve-existing,inspect,promote-denied,approve,promote-cas",
    "preparation:fault-recovery,authority,traffic-explicitly-deferred",
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

test("contains no removed manual native CI or review trigger", async () => {
  const source = `${await readFile(script, "utf8")}\n${await readFile(runLibrary, "utf8")}\n${await readFile(evidenceLibrary, "utf8")}`;

  assert.doesNotMatch(source, /project admit|operator review create|workspace restart|ORDINARY_ADMISSION_CONFIG/);
  assert.match(source, /operator review resolve/);
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
  assert.match(source, /cutover_deferred_phase_manifest/);
  assert.match(source, /mv -- "\$smoke_result_temporary" "\$evidence\/SMOKE-PASSED"/);
});

test("runbook host fixtures satisfy the current strict production parsers", async () => {
  // Given
  const source = await readFile(runbook, "utf8");
  const ordinaryService = documentedJson(source, "ordinary-service");
  const ordinary = documentedJson(source, "ordinary-host");
  const qemuHost = documentedJson(source, "qemu-host");
  const qemuScheduler = documentedJson(source, "qemu-scheduler");

  // When
  const parsedOrdinaryService = parseNativeOrdinaryBundleConfig(ordinaryService);
  const parsedOrdinary = parseNativeRootCiHostConfig(ordinary);
  const parsedQemuHost = parseNativeQemuConnection(qemuHost, "qemu-a");
  const parsedQemuScheduler = parseNativeQemuSchedulerConfig(qemuScheduler);

  // Then
  assert.equal(parsedOrdinaryService.schemaVersion, 5);
  assert.equal(parsedOrdinaryService.database, "/var/lib/dim-ordinary-ci/ordinary-ci.sqlite3");
  assert.deepEqual(Object.keys(parsedOrdinary.nativeGit), ["transport", "endpoint", "serviceId"]);
  assert.deepEqual(Object.keys(parsedQemuHost.nativeGit), ["transport", "endpoint", "serviceId"]);
  assert.deepEqual(Object.keys(parsedQemuScheduler.nativeGit), [
    "endpoint", "serviceId", "identity", "attemptIssuer", "candidateReader", "resultReporter"
  ]);
  assert.throws(() => parseNativeOrdinaryBundleConfig({ ...ordinaryService, admissionLeaseMilliseconds: 1 }));
  assert.throws(() => parseNativeQemuSchedulerConfig({ ...qemuScheduler, listen: { host: "127.0.0.1", port: 9090 } }));
});

test("starts every global CI service without Project admission and arms cleanup first", async () => {
  // Given
  const driver = `
set -euo pipefail
source "$1"
  declare -A CUTOVER_CONFIG=(
  [CONTROL_SSH]=control [ORDINARY_SSH]=ordinary [QEMU_SCHEDULER_CONFIG]=/qemu-scheduler
  [QEMU_SCHEDULER_UNIT]=qemu-scheduler.service [QEMU_HOST_UNIT]=qemu-host.service
  [ORDINARY_UNIT]=ordinary.service
)
CUTOVER_STARTED_SERVICES=0
cutover_ssh() { printf '%s\\n' "$*"; }
cutover_wait_for_qemu_scheduler() { printf 'scheduler-ready\\n'; }
cutover_start_global_ci
printf 'armed:%s\\n' "$CUTOVER_STARTED_SERVICES"
`;

  const result = await exec("bash", ["-c", driver, "bash", runLibrary]);

  const calls = result.stdout.trim().split("\n");
  assert.match(calls[0], /systemctl --user start qemu-scheduler\.service/);
  assert.equal(calls[1], "scheduler-ready");
  assert.match(calls[2], /systemctl --user start qemu-host\.service/);
  assert.match(calls[3], /systemctl --user start ordinary\.service/);
  assert.equal(calls[4], "armed:1");
  assert.doesNotMatch(result.stdout, /project admit/);
});

test("selects the numerically latest ordinary terminal attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-native-cutover-test-"));
  temporaryRoots.push(root);
  const reviewId = "a".repeat(64);
  const ordinaryRoot = join(root, "dim-authoritative-statuses", "ordinary-sysbox", reviewId, "source");
  const qemuRoot = join(root, "dim-authoritative-qemu");
  await mkdir(ordinaryRoot, { recursive: true });
  await mkdir(qemuRoot, { recursive: true });
  const ordinary = (attempt) => ({ schemaVersion: 3, payload: { executionKind: "ordinary-sysbox",
    reviewId, attempt, descriptor: { jobName: "source" }, stdout: { truncated: false, sha256: `sha256:${attempt}` } } });
  await writeFile(join(ordinaryRoot, "9.json"), JSON.stringify(ordinary(9)));
  await writeFile(join(ordinaryRoot, "10.json"), JSON.stringify(ordinary(10)));
  await writeFile(join(qemuRoot, "state.json"), JSON.stringify({ schemaVersion: 1,
    attempts: [{ reviewId, attemptId: "qemu-attempt", descriptor: { jobName: "integration" } }],
    statuses: [{ schemaVersion: 1, attemptId: "qemu-attempt", result: "success", event: { schemaVersion: 3,
      payload: { executionKind: "qemu", reviewId, attemptId: "qemu-attempt",
        descriptor: { jobName: "integration" }, stdout: { truncated: false, sha256: "sha256:qemu" } } } }] }));
  const driver = `
set -euo pipefail
source "$1"
declare -A CUTOVER_CONFIG=([CONTROL_SSH]=local [NATIVE_GIT_CONTAINER]=native [PROJECT_ID]=project [ORDINARY_JOB]=source [QEMU_JOB]=integration)
CUTOVER_REVIEW_ID="$3"
TEST_REPOSITORY="$2"
cutover_ssh() {
  shift
  while [[ "$1" != node ]]; do shift; done
  arguments=("$@")
  arguments[3]="$TEST_REPOSITORY"
  "\${arguments[@]}"
}
cutover_read_terminal_evidence
`;

  const result = await exec("bash", ["-c", driver, "bash", runLibrary, root, reviewId]);

  assert.equal(JSON.parse(result.stdout).ordinary.event.payload.attempt, 10);
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
