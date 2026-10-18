import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import { openNativeQemuSchedulerDatabase } from "../../core/packages/managed/src/nativeQemuSchedulerDatabase.ts";
import { assertWorkspaceRecord } from "../../core/packages/managed/src/workspaceRecord.ts";

const exec = promisify(execFile);
const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(verificationRoot, "scripts", "native-cutover-policy-matrix.bash");
const commonLibrary = join(verificationRoot, "scripts", "lib", "native-cutover-clean-host-common.bash");
const cleanRunLibrary = join(verificationRoot, "scripts", "lib", "native-cutover-clean-host-run.bash");
const runLibrary = join(verificationRoot, "scripts", "lib", "native-cutover-policy-matrix-run.bash");
const ordinaryServiceHelper = join(
  verificationRoot, "scripts", "lib", "native-cutover-policy-matrix-ordinary-service.bash"
);
const example = join(verificationRoot, "native-cutover-policy-matrix.conf.example");
const qemuCapacity = (capacity, runnerDigit, jobDigit) => ({ capacity,
  runnerBaseImage: `registry.example/qemu-runner@sha256:${runnerDigit.repeat(64)}`,
  jobBaseImage: `registry.example/job@sha256:${jobDigit.repeat(64)}`,
  bounds: { cpu: "4", memoryBytes: "8589934592", pids: "2048", wallClockSeconds: "1800",
    outputBytes: "10485760" } });
const qemuExecutionAuthority = [
  { hostId: "qemu-a", capacities: [qemuCapacity("qemu-a-1", "6", "7"), qemuCapacity("qemu-a-2", "8", "9")] },
  { hostId: "qemu-b", capacities: [qemuCapacity("qemu-b-1", "a", "b")] }
];
const qemuExecutionAuthorityJson = JSON.stringify(qemuExecutionAuthority);
const qemuHosts = [
  { ...qemuExecutionAuthority[1], hostToken: "B".repeat(43) },
  { ...qemuExecutionAuthority[0], hostToken: "A".repeat(43),
    capacities: [...qemuExecutionAuthority[0].capacities].reverse() }
];
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("prints the complete four-profile installed-command plan", async () => {
  const result = await exec("bash", [script, "--print-command-plan"]);

  assert.deepEqual(result.stdout.trim().split("\n"), [
    "preflight:ssh-source-snapshots-package-files-runtime-node-separation-no-mutation",
    "install:just-install-local,dim-installer-install-control-plane",
    "profile-empty:owned-ordinary-readiness-outage,restore,start-all-ci,proposal-autoqueue,resolve,approve,promotion-cas,all-results,cleanup",
    "profile-ordinary:start-all-ci,proposal-autoqueue,ordinary-quality,resolve,required-result,approve,promotion-cas,all-results,cleanup",
    "profile-qemu:owned-ordinary-readiness-outage,restore,start-all-ci,proposal-autoqueue,qemu-quality,resolve,required-result,approve,promotion-cas,all-results,cleanup",
    "profile-dual:start-all-ci,proposal-autoqueue,dual-quality,resolve,required-results,approve,promotion-cas,all-results,cleanup",
    "evidence:envelope2-events3,executedJobs,qualityRequiredJobs,owned-central-state,protected-cas,atomic-markers",
    "preparation:fault-recovery,authority,traffic-explicitly-deferred",
    "deferred:fault-authority-traffic-recovery-independent-host-execution"
  ]);
  assert.equal(result.stderr, "");
});

test("preflight uses only fixed SSH probes and creates no evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-native-matrix-test-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const config = join(root, "operator.conf");
  const evidence = join(root, "evidence");
  const log = join(root, "ssh.log");
  await exec("mkdir", ["-p", bin]);
  const helper = join(bin, "ssh");
  await writeFile(helper, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$MATRIX_TEST_SSH_LOG"
payload="$(cat)"
target=""
for argument in "$@"; do
  if [[ "$argument" == -- ]]; then seen=1; continue; fi
  if [[ "\${seen:-0}" == 1 ]]; then target="$argument"; break; fi
done
if [[ "$payload" == *'stateIdentity'* ]]; then
  suffix=control
  [[ "$target" == dim-ordinary ]] && suffix=ordinary
  printf '{"machineId":"machine-%s","bootId":"boot-%s","dockerId":"docker-%s","stateIdentity":"state-%s","commit":"%s","dimVersion":"0.0-test","aggregateLockSha256":"lock","packageSha256":"packages"}\\n' "$suffix" "$suffix" "$suffix" "$suffix" "${"0".repeat(40)}"
elif [[ "$payload" == *'sources='* ]]; then
  printf '[{"profile":"empty","tree":"%s"},{"profile":"ordinary","tree":"%s"},{"profile":"qemu","tree":"%s"},{"profile":"dual","tree":"%s"}]\\n' "${"1".repeat(40)}" "${"2".repeat(40)}" "${"3".repeat(40)}" "${"4".repeat(40)}"
fi
`, { mode: 0o755 });
  const source = (await readFile(example, "utf8"))
    .replace("EVIDENCE_DIR=/srv/dim-evidence/native-cutover-policy-matrix", `EVIDENCE_DIR=${evidence}`);
  await writeFile(config, source, { mode: 0o600 });
  await chmod(config, 0o600);

  const result = await exec("bash", [script, "--preflight-only", config], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MATRIX_TEST_SSH_LOG: log }
  });

  assert.match(result.stdout, /matrix prerequisites available/);
  await assert.rejects(readFile(evidence));
  const calls = await readFile(log, "utf8");
  assert.doesNotMatch(calls, /install-local|installer install|project create|workspace create|project admit|systemctl --user start/);
});

test("rejects caller-selected commands before SSH or evidence mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-native-matrix-test-"));
  temporaryRoots.push(root);
  const config = join(root, "operator.conf");
  const evidence = join(root, "evidence");
  const source = `${await readFile(example, "utf8")}REMOTE_COMMAND=rm -rf /\n`
    .replace("EVIDENCE_DIR=/srv/dim-evidence/native-cutover-policy-matrix", `EVIDENCE_DIR=${evidence}`);
  await writeFile(config, source, { mode: 0o600 });

  const result = await execFailure("bash", [script, "--preflight-only", config]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown key 'REMOTE_COMMAND'/);
  assert.doesNotMatch(result.stderr, /ssh:/i);
  await assert.rejects(readFile(evidence));
});

test("strictly rejects the removed ordinary admission config key", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-native-matrix-test-"));
  temporaryRoots.push(root);
  const config = join(root, "operator.conf");
  const source = `${await readFile(example, "utf8")}ORDINARY_ADMISSION_CONFIG=/obsolete/admission.json\n`;
  await writeFile(config, source, { mode: 0o600 });

  const result = await execFailure("bash", [script, "--preflight-only", config]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown key 'ORDINARY_ADMISSION_CONFIG'/);
  assert.doesNotMatch(result.stderr, /ssh:/i);
});

test("starts all global executors before proposal work without Project admission", async () => {
  const driver = `
set -euo pipefail
source "$1"
declare -A CUTOVER_CONFIG=(
  [CONTROL_SSH]=control [ORDINARY_SSH]=ordinary [QEMU_SCHEDULER_CONFIG]=/qemu-scheduler
  [QEMU_SCHEDULER_UNIT]=qemu-scheduler.service [QEMU_HOST_UNIT]=qemu-host.service
  [ORDINARY_UNIT]=ordinary.service
)
CUTOVER_STARTED_ORDINARY=0
CUTOVER_STARTED_QEMU_SCHEDULER=0
CUTOVER_STARTED_QEMU_HOST=0
cutover_ssh() { printf '%s\\n' "$*"; }
matrix_assert_owned_ordinary_ci_running() { :; }
cutover_wait_for_qemu_scheduler() { printf 'scheduler-ready\\n'; }
matrix_start_global_ci
printf 'flags:%s:%s:%s\\n' "$CUTOVER_STARTED_ORDINARY" "$CUTOVER_STARTED_QEMU_SCHEDULER" "$CUTOVER_STARTED_QEMU_HOST"
`;

  const result = await exec("bash", ["-c", driver, "bash", runLibrary]);
  const calls = result.stdout.trim().split("\n");
  assert.match(calls[0], /systemctl --user start qemu-scheduler\.service/);
  assert.equal(calls[1], "scheduler-ready");
  assert.match(calls[2], /systemctl --user start qemu-host\.service/);
  assert.match(calls[3], /systemctl --user start ordinary\.service/);
  assert.equal(calls[4], "flags:1:1:1");
  assert.doesNotMatch(result.stdout, /project admit/);
});

test("probes schema-2 QEMU config and schema-3 generation-bound database before automatic queueing", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-native-matrix-test-"));
  temporaryRoots.push(root);
  const config = join(root, "qemu-scheduler.json");
  const database = join(root, "qemu.sqlite3");
  const sqlite = openNativeQemuSchedulerDatabase(database, qemuExecutionAuthorityJson);
  const generationRow = sqlite.prepare("SELECT value FROM native_qemu_metadata WHERE key=?")
    .get("service_generation_id");
  const serviceGenerationId = generationRow?.value;
  assert.equal(typeof serviceGenerationId, "string");
  sqlite.close();
  const scheduler = createServer((request, response) => {
    assert.equal(request.url, "/healthz");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ serviceId: "qemu-main", status: "ready" }));
  });
  await new Promise((resolve, reject) => {
    scheduler.once("error", reject);
    scheduler.listen(0, "127.0.0.1", resolve);
  });
  const address = scheduler.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(config, JSON.stringify({ schemaVersion: 2, serviceId: "qemu-main", host: "127.0.0.1",
    port: address.port, database, hosts: qemuHosts }));
  const driver = `
set -euo pipefail
source "$1"
declare -A CUTOVER_CONFIG=([CONTROL_SSH]=local [QEMU_SCHEDULER_CONFIG]="$2")
cutover_ssh() { shift; "$@"; }
cutover_wait_for_qemu_scheduler
`;

  let result;
  try {
    result = await exec("bash", ["-c", driver, "bash", cleanRunLibrary, config]);
  } finally {
    await new Promise((resolve, reject) => scheduler.close((error) => error ? reject(error) : resolve()));
  }
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, serviceId: "qemu-main", status: "ready",
    serviceGenerationId, executionAuthority: qemuExecutionAuthority,
    contracts: { qemuConfigSchema: 2, qemuDatabaseSchema: 3 } });
});

test("rejects a schema-2 QEMU scheduler database before probing health", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-native-matrix-test-"));
  temporaryRoots.push(root);
  const config = join(root, "qemu-scheduler.json");
  const database = join(root, "qemu.sqlite3");
  const sqlite = new DatabaseSync(database);
  sqlite.exec("PRAGMA user_version=2");
  sqlite.close();
  await writeFile(config, JSON.stringify({ schemaVersion: 2, serviceId: "qemu-main", host: "127.0.0.1",
    port: 1, database }));
  const driver = `
set -euo pipefail
source "$1"
declare -A CUTOVER_CONFIG=([CONTROL_SSH]=local [QEMU_SCHEDULER_CONFIG]="$2")
cutover_ssh() { shift; "$@"; }
cutover_wait_for_qemu_scheduler
`;

  const result = await execFailure("bash", ["-c", driver, "bash", cleanRunLibrary, config]);

  assert.notEqual(result.code, 0);
});

test("rejects a malformed QEMU scheduler service generation before accepting health", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-native-matrix-test-"));
  temporaryRoots.push(root);
  const config = join(root, "qemu-scheduler.json");
  const database = join(root, "qemu.sqlite3");
  const sqlite = new DatabaseSync(database);
  sqlite.exec(`CREATE TABLE native_qemu_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version=3;`);
  const insert = sqlite.prepare("INSERT INTO native_qemu_metadata (key,value) VALUES (?,?)");
  insert.run("execution_authority_json", qemuExecutionAuthorityJson);
  insert.run("schema_version", "3");
  insert.run("service_generation_id", "not-a-uuid");
  sqlite.close();
  const scheduler = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ serviceId: "qemu-main", status: "ready" }));
  });
  await new Promise((resolve, reject) => {
    scheduler.once("error", reject);
    scheduler.listen(0, "127.0.0.1", resolve);
  });
  const address = scheduler.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(config, JSON.stringify({ schemaVersion: 2, serviceId: "qemu-main", host: "127.0.0.1",
    port: address.port, database, hosts: qemuHosts }));
  const driver = `
set -euo pipefail
source "$1"
declare -A CUTOVER_CONFIG=([CONTROL_SSH]=local [QEMU_SCHEDULER_CONFIG]="$2")
cutover_ssh() { shift; "$@"; }
cutover_wait_for_qemu_scheduler
`;

  let result;
  try {
    result = await execFailure("bash", ["-c", driver, "bash", cleanRunLibrary, config]);
  } finally {
    await new Promise((resolve, reject) => scheduler.close((error) => error ? reject(error) : resolve()));
  }
  assert.notEqual(result.code, 0);
});

test("rejects missing QEMU execution authority metadata before accepting health", async () => {
  const result = await runInvalidAuthorityProbe((sqlite) => {
    const insert = sqlite.prepare("INSERT INTO native_qemu_metadata (key,value) VALUES (?,?)");
    insert.run("schema_version", "3");
    insert.run("service_generation_id", "123e4567-e89b-42d3-a456-426614174000");
  });

  assert.notEqual(result.code, 0);
});

test("rejects mismatched QEMU execution authority metadata before accepting health", async () => {
  const result = await runInvalidAuthorityProbe((sqlite) => {
    const insert = sqlite.prepare("INSERT INTO native_qemu_metadata (key,value) VALUES (?,?)");
    insert.run("execution_authority_json", "not-canonical-json");
    insert.run("schema_version", "3");
    insert.run("service_generation_id", "123e4567-e89b-42d3-a456-426614174000");
  });

  assert.notEqual(result.code, 0);
});

test("validates all planned jobs independently from the quality-required subset", async () => {
  const ordinary = { executionKind: "ordinary-sysbox", jobName: "source", evidenceClass: "candidate-controlled" };
  const qemu = { executionKind: "qemu", jobName: "integration", evidenceClass: "candidate-controlled" };
  const argv = ["/bin/bash", "--noprofile", "--norc", "/run/dim/job/script"];
  const planned = (job) => ({ ...job, script: { path: `.dim/ci/jobs/${job.jobName}.bash`,
    objectId: "a".repeat(40), sha256: `sha256:${"b".repeat(64)}` }, argv });
  const event = (job) => ({ schemaVersion: 3, type: "dim.native.review-job.available", ...job });
  const envelope = (requiredJobs) => JSON.stringify({ schemaVersion: 2, requiredJobs,
    planning: { status: "valid", jobs: [planned(ordinary), planned(qemu)] }, events: [event(ordinary), event(qemu)] });
  const driver = `
set -euo pipefail
source "$1"
source "$2"
declare -A CUTOVER_CONFIG=([ORDINARY_JOB]=source [QEMU_JOB]=integration)
matrix_assert_review_profile "$3" "$4"
`;

  for (const [profile, required] of [["empty", []], ["ordinary", [ordinary]], ["qemu", [qemu]], ["dual", [ordinary, qemu]]]) {
    await exec("bash", ["-c", driver, "bash", commonLibrary, runLibrary, profile, envelope(required)]);
  }
});

test("keeps schema-9 workspace shape without a manual protected-root refresh", async () => {
  const objectId = "a".repeat(40);
  const treeId = "b".repeat(40);
  const workspace = {
    schemaVersion: 9,
    workspaceId: Buffer.alloc(32, 1).toString("base64url"),
    name: "work-1",
    projectId: "project-a",
    projectName: "project-a",
    rootRepositoryAlias: "root",
    rootRef: "refs/heads/main",
    rootCommit: objectId,
    workspaceDataPath: "/var/lib/dim/workspace-data",
    phase: "ready",
    profiles: [],
    composeProjectName: "dim-work-1",
    containerName: "dim-ws-work-1",
    networkName: "bridge",
    dockerVolumeName: "dim-ws-work-1-docker",
    runtimeBackend: "sysbox",
    kvm: false,
    cpuCount: "2",
    memory: "4g",
    pidsLimit: "2048",
    routes: [],
    gitUserName: "DIM Test",
    gitUserEmail: "dim@example.invalid",
    hostAliases: {},
    projectManifestPath: "/run/dim/project.json",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: {
      kind: "native",
      serviceId: "native-main",
      snapshot: { projectId: "project-a", repositoryId: "root", protectedRef: "refs/heads/main", commit: objectId, tree: treeId },
      policyRevision: "policy",
      requiredReviewRevision: "review",
      requiredJobSetRevision: "jobs"
    }
  };
  assertWorkspaceRecord(workspace, "production-show-shape");
  const source = await readFile(script, "utf8");

  assert.equal(workspace.source.snapshot.tree, treeId);
  assert.equal(Object.hasOwn(workspace, "rootTree"), false);
  assert.doesNotMatch(source, /workspace restart/);
  assert.doesNotMatch(source, /\.\[-1\]\.rootTree/);
});

test("keeps the owned ordinary service stopped through readiness then restores it before automatic CI", async () => {
  const source = await readFile(script, "utf8");
  const stop = source.indexOf("matrix_stop_owned_ordinary_ci");
  const create = source.indexOf("cutover_create_project_workspace", stop);
  const readiness = source.indexOf("matrix_assert_ready_ci_stopped", create);
  const restore = source.indexOf("matrix_restore_owned_ordinary_ci", readiness);
  const start = source.indexOf("matrix_start_global_ci", restore);
  const proposal = source.indexOf("cutover_create_proposal", start);

  assert.ok(stop >= 0 && stop < create);
  assert.ok(create < readiness);
  assert.ok(readiness < restore);
  assert.ok(restore < start);
  assert.ok(start < proposal);
});

test("stops and restores only the label-validated immutable ordinary service ID", async () => {
  const fixture = await ordinaryServiceFixture();
  const inspected = JSON.parse((await exec("bash", [ordinaryServiceHelper, "inspect", fixture.container, fixture.install], {
    env: fixture.env
  })).stdout);
  const stopped = JSON.parse((await exec("bash", [ordinaryServiceHelper, "stop", fixture.container, fixture.install,
    inspected.identity.containerId, inspected.stateSha256], { env: fixture.env })).stdout);
  assert.equal(stopped.action, "stopped");
  assert.equal(await readFile(fixture.running, "utf8"), "false\n");

  const restored = JSON.parse((await exec("bash", [ordinaryServiceHelper, "start", fixture.container, fixture.install,
    stopped.identity.containerId, stopped.stateSha256], { env: fixture.env })).stdout);
  assert.equal(restored.action, "started");
  assert.equal(restored.identity.containerId, stopped.identity.containerId);
  assert.equal(restored.stateSha256, stopped.stateSha256);
  assert.equal(await readFile(fixture.running, "utf8"), "true\n");
  const calls = await readFile(fixture.log, "utf8");
  assert.match(calls, new RegExp(`container stop ${stopped.identity.containerId}`));
  assert.match(calls, new RegExp(`container start ${stopped.identity.containerId}`));
  assert.match(calls, /dim-service activate [0-9a-f]{64}/);
  assert.doesNotMatch(calls, /container (stop|start) unrelated/);
});

test("refuses a foreign ordinary service before stop and leaves it running", async () => {
  const fixture = await ordinaryServiceFixture();
  const result = await execFailure("bash", [ordinaryServiceHelper, "inspect", fixture.container, fixture.install], {
    ...fixture.env,
    MATRIX_TEST_FOREIGN: "1"
  });

  assert.match(result.stderr, /ownership labels/);
  assert.equal(await readFile(fixture.running, "utf8"), "true\n");
  assert.doesNotMatch(await readFile(fixture.log, "utf8"), /container stop/);
});

test("quality evidence gates only the selected subset while executed evidence requires both jobs", async () => {
  const driver = `
set -euo pipefail
source "$1"
source "$2"
matrix_assert_quality_evidence "$3" "$4" ordinary-digest qemu-digest
`;
  const ordinaryOnly = JSON.stringify({ ordinary: { result: "success", digest: "ordinary-digest" } });
  const wrongKind = JSON.stringify({ qemu: { result: "success", digest: "qemu-digest" } });
  const both = JSON.stringify({ ordinary: { result: "success", digest: "ordinary-digest" },
    qemu: { result: "success", digest: "qemu-digest" } });

  await exec("bash", ["-c", driver, "bash", commonLibrary, runLibrary, "empty", "{}"]);
  await exec("bash", ["-c", driver, "bash", commonLibrary, runLibrary, "ordinary", ordinaryOnly]);
  const denial = await execFailure("bash", ["-c", driver, "bash", commonLibrary, runLibrary, "ordinary", wrongKind]);
  const executedDriver = `${driver.replace("matrix_assert_quality_evidence", "matrix_assert_executed_evidence")}`;
  await exec("bash", ["-c", executedDriver, "bash", commonLibrary, runLibrary, "dual", both]);
  const incomplete = await execFailure("bash", ["-c", executedDriver, "bash", commonLibrary, runLibrary, "dual", ordinaryOnly]);

  assert.notEqual(denial.code, 0);
  assert.match(denial.stderr, /ordinary quality-required evidence/);
  assert.match(incomplete.stderr, /executed job evidence/);
});

test("reads the numerically latest ordinary attempt for matrix evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "dim-native-matrix-test-"));
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
matrix_read_terminal_evidence
`;

  const result = await exec("bash", ["-c", driver, "bash", runLibrary, root, reviewId]);

  assert.equal(JSON.parse(result.stdout).ordinary.event.payload.attempt, 10);
});

test("contains no manual admission, review creation, or workspace refresh and records separate job scopes", async () => {
  const source = `${await readFile(script, "utf8")}\n${await readFile(runLibrary, "utf8")}\n${await readFile(cleanRunLibrary, "utf8")}`;

  assert.doesNotMatch(source, /project admit|operator review create|workspace restart|ORDINARY_ADMISSION_CONFIG/);
  assert.match(source, /operator review resolve/);
  assert.match(source, /executedJobs/);
  assert.match(source, /qualityRequiredJobs/);
});

test("publishes bounded atomic profile and matrix manifests without an acceptance claim", async () => {
  const source = await readFile(script, "utf8");

  assert.match(source, /PROFILE-PASSED/);
  assert.match(source, /MATRIX-PASSED/);
  assert.match(source, /mv -- "\$profile_result_temporary" "\$profile_evidence\/PROFILE-PASSED"/);
  assert.match(source, /mv -- "\$matrix_result_temporary" "\$evidence\/MATRIX-PASSED"/);
  assert.match(source, /VERIFICATION-NATIVE-CUTOVER-001-not-satisfied/);
  assert.match(source, /fault-result-denials/);
  assert.match(source, /guest-authority-inspection/);
  assert.match(source, /traffic-inspection/);
  assert.match(source, /host-reboot-recovery/);
  assert.doesNotMatch(source, /FULL-GATE-PASSED|ACCEPTED|fullGate:\s*"satisfied"/);
});

test("packages the matrix through the verification recipe", async () => {
  const recipe = await readFile(join(verificationRoot, "verify.just"), "utf8");

  assert.match(recipe, /native-cutover-policy-matrix config:/);
  assert.match(recipe, /native-cutover-policy-matrix\.bash "\{\{config\}\}"/);
});

test("stops global executors before discarding the exact workspace", async () => {
  const driver = `
set -euo pipefail
source "$1"
declare -A CUTOVER_CONFIG=(
  [CONTROL_SSH]=control [ORDINARY_SSH]=ordinary [CONTROL_PLANE_CONNECTION]=/control
  [WORKSPACE_NAME]=owned-workspace [ORDINARY_UNIT]=ordinary.service
  [ORDINARY_STATE_DIRECTORY]=/state
)
CUTOVER_PROFILE=ordinary
CUTOVER_STARTED_ORDINARY=1
CUTOVER_STARTED_QEMU_SCHEDULER=0
CUTOVER_STARTED_QEMU_HOST=0
MATRIX_WORKSPACE_CREATED=1
cutover_ssh() {
  printf '%s\\n' "$*"
  if [[ "$*" == *'bash -s -- /state' ]]; then cat >/dev/null; fi
}
matrix_cleanup_profile
`;

  const result = await exec("bash", ["-c", driver, "bash", runLibrary]);
  const calls = result.stdout.trim().split("\n");

  assert.match(calls[0], /systemctl --user stop ordinary\.service/);
  assert.match(calls[1], /dim workspace discard owned-workspace --yes/);
});

test("reports global-service stop failure instead of clearing ownership flags", async () => {
  const driver = `
set -euo pipefail
source "$1"
declare -A CUTOVER_CONFIG=(
  [CONTROL_SSH]=control [ORDINARY_SSH]=ordinary
  [QEMU_HOST_UNIT]=qemu-host.service [QEMU_SCHEDULER_UNIT]=qemu-scheduler.service
  [ORDINARY_UNIT]=ordinary.service
)
CUTOVER_STARTED_ORDINARY=1
CUTOVER_STARTED_QEMU_SCHEDULER=1
CUTOVER_STARTED_QEMU_HOST=1
cutover_ssh() { [[ "$*" != *'qemu-host.service' ]]; }
if matrix_stop_global_ci; then exit 9; fi
printf '%s:%s:%s\n' "$CUTOVER_STARTED_ORDINARY" "$CUTOVER_STARTED_QEMU_SCHEDULER" "$CUTOVER_STARTED_QEMU_HOST"
`;

  const result = await exec("bash", ["-c", driver, "bash", runLibrary]);

  assert.equal(result.stdout, "0:0:1\n");
});

async function runInvalidAuthorityProbe(seedMetadata) {
  const root = await mkdtemp(join(tmpdir(), "dim-native-matrix-test-"));
  temporaryRoots.push(root);
  const config = join(root, "qemu-scheduler.json");
  const database = join(root, "qemu.sqlite3");
  const sqlite = new DatabaseSync(database);
  sqlite.exec(`CREATE TABLE native_qemu_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version=3;`);
  seedMetadata(sqlite);
  sqlite.close();
  const scheduler = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ serviceId: "qemu-main", status: "ready" }));
  });
  await new Promise((resolve, reject) => {
    scheduler.once("error", reject);
    scheduler.listen(0, "127.0.0.1", resolve);
  });
  const address = scheduler.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(config, JSON.stringify({ schemaVersion: 2, serviceId: "qemu-main", host: "127.0.0.1",
    port: address.port, database, hosts: qemuHosts }));
  const driver = `
set -euo pipefail
source "$1"
declare -A CUTOVER_CONFIG=([CONTROL_SSH]=local [QEMU_SCHEDULER_CONFIG]="$2")
cutover_ssh() { shift; "$@"; }
cutover_wait_for_qemu_scheduler
`;
  try {
    return await execFailure("bash", ["-c", driver, "bash", cleanRunLibrary, config]);
  } finally {
    await new Promise((resolve, reject) => scheduler.close((error) => error ? reject(error) : resolve()));
  }
}

async function ordinaryServiceFixture() {
  const root = await mkdtemp(join(tmpdir(), "dim-native-ordinary-service-test-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const install = join(root, "install.json");
  const running = join(root, "running");
  const log = join(root, "docker.log");
  const container = "dim-control-plane-ordinary-ci-1";
  const containerId = "1".repeat(64);
  const imageId = `sha256:${"2".repeat(64)}`;
  const image = `registry.example/ordinary@sha256:${"3".repeat(64)}`;
  await mkdir(bin);
  await writeFile(install, `${JSON.stringify({ deploymentId: "native-main", ordinaryCi: { image } })}\n`, { mode: 0o600 });
  await writeFile(running, "true\n");
  await writeFile(log, "");
  await writeFile(join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$MATRIX_TEST_DOCKER_LOG"
case "$1 $2" in
  "container inspect")
    deployment=native-main
    [[ "\${MATRIX_TEST_FOREIGN:-0}" == 1 ]] && deployment=foreign
    labels="$(printf '{\"org.dim.managed\":\"true\",\"org.dim.bundle\":\"control-plane\",\"org.dim.deployment\":\"%s\",\"org.dim.resource\":\"service\",\"org.dim.service\":\"ordinary-ci\",\"com.docker.compose.project\":\"dim-control-plane\",\"com.docker.compose.service\":\"ordinary-ci\",\"com.docker.compose.container-number\":\"1\",\"com.docker.compose.oneoff\":\"False\"}' "$deployment")"
    printf '%s\\n/%s\\n%s\\n%s\\n%s\\n%s\\n' '${containerId}' '${container}' '${imageId}' '${image}' '["serve","/run/secrets/service.json","${"5".repeat(64)}"]' "$labels"
    cat "$MATRIX_TEST_RUNNING"
    ;;
  "container exec")
    if [[ "$*" == *'node --input-type=module'* ]]; then
      printf '%s\\n' '${"4".repeat(64)}'
    fi
    ;;
  "container stop") printf 'false\\n' >"$MATRIX_TEST_RUNNING"; printf '%s\\n' '${containerId}' ;;
  "container start") printf 'true\\n' >"$MATRIX_TEST_RUNNING"; printf '%s\\n' '${containerId}' ;;
  *) printf 'unexpected docker invocation: %s\\n' "$*" >&2; exit 9 ;;
esac
`, { mode: 0o755 });
  return {
    root, install, running, log, container,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MATRIX_TEST_RUNNING: running, MATRIX_TEST_DOCKER_LOG: log }
  };
}

async function execFailure(file, args, env = process.env) {
  try {
    await exec(file, args, { env });
  } catch (error) {
    if (error instanceof Error && "code" in error && "stderr" in error) return error;
    throw error;
  }
  throw new Error("command unexpectedly succeeded");
}
