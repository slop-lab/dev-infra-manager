import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";

const exec = promisify(execFile);
const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(verificationRoot, "scripts", "native-multi-host-operations.bash");
const runLibrary = join(verificationRoot, "scripts", "lib", "native-multi-host-operations-run.bash");
const cleanupLibrary = join(verificationRoot, "scripts", "lib", "native-multi-host-operations-cleanup.bash");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("prints bounded operations help and a proposal-only command plan", async () => {
  const help = await exec("bash", [script, "--help"]);
  const plan = await exec("bash", [script, "--print-command-plan"]);

  assert.match(help.stdout, /--preflight-only/);
  assert.match(help.stdout, /DISPOSABLE_EXCLUSIVE_NODES_ACK/);
  assert.match(plan.stdout, /proposal:proposal-only/);
  assert.match(plan.stdout, /restart:clean-idle-workers-before-scheduler/);
  assert.doesNotMatch(plan.stdout, /approve|promote|protected-write|denial-probe/i);
});

test.each([
  ["unknown", (source) => `${source}UNREVIEWED_COMMAND=touch /tmp/no\n`, /unknown key 'UNREVIEWED_COMMAND'/],
  ["duplicate", (source) => `${source}CONTROL_SSH=other\n`, /repeats 'CONTROL_SSH'/],
  ["permissive", (source) => source, /caller-owned mode-0600/]
])("rejects %s config before SSH or evidence creation", async (_label, mutate, diagnostic) => {
  const fixture = await configFixture();
  const source = mutate(await readFile(fixture.config, "utf8"));
  await writeFile(fixture.config, source, { mode: 0o600 });
  if (_label === "permissive") await chmod(fixture.config, 0o644);

  const result = await execFailure("bash", [script, "--preflight-only", fixture.config]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, diagnostic);
  await assert.rejects(stat(fixture.evidence));
});

test.each([
  ["PROJECT_NAME", "p".repeat(49), /PROJECT_NAME is invalid/],
  ["WORKSPACE_NAME", "w".repeat(49), /WORKSPACE_NAME is invalid/],
  ["PROJECT_ID", `bad.id`, /PROJECT_ID is invalid/],
  ["PROJECT_ID", "p".repeat(65), /PROJECT_ID is invalid/],
  ["QEMU_HOST_UNIT", "dim-qemu-scheduler.service", /QEMU units must differ/],
  ["QEMU_JOB", "source", /ordinary and QEMU jobs must differ/]
])("rejects invalid lifecycle topology in %s before SSH", async (key, value, diagnostic) => {
  const fixture = await configFixture();
  const source = (await readFile(fixture.config, "utf8")).replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
  await writeFile(fixture.config, source, { mode: 0o600 });

  const result = await execFailure("bash", [script, "--preflight-only", fixture.config]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, diagnostic);
});

test("rejects duplicate machine identity and mismatched prepared artifacts", async () => {
  const common = join(verificationRoot, "scripts", "lib", "native-multi-host-operations-common.bash");
  const identity = (machine, packageHash) => JSON.stringify({ machineId: machine, bootId: `boot-${machine}`, dockerId: `docker-${machine}`,
    stateIdentity: `state-${machine}`, commit: "a".repeat(40), dimVersion: "0.9.0", aggregateLockSha256: "b".repeat(64),
    packageSha256: packageHash, preparedImageRef: "image@sha256:" + "d".repeat(64), preparedImageId: "sha256:" + "e".repeat(64) });
  const driver = `set -euo pipefail; source "$1"; declare -A OPS_CONFIG=([QEMU_HOST_ID]=qemu [ORDINARY_HOST_ID]=ordinary); ops_assert_node_separation "$2" "$3"`;

  const duplicate = await execFailure("bash", ["-c", driver, "bash", common, identity("same", "c".repeat(64)), identity("same", "c".repeat(64))]);
  const mismatch = await execFailure("bash", ["-c", driver, "bash", common, identity("control", "c".repeat(64)), identity("ordinary", "f".repeat(64))]);

  assert.match(duplicate.stderr, /share (machineId|bootId|dockerId|stateIdentity)/);
  assert.match(mismatch.stderr, /differ in prepared packageSha256/);
});

test("executes two unique candidates around one clean idle restart without review or promotion", async () => {
  const driver = String.raw`
set -euo pipefail
source "$1"
declare -A OPS_CONFIG=([PROJECT_COMMIT]="$(printf 'a%.0s' {1..40})")
PROJECT_COMMIT="$(printf 'a%.0s' {1..40})"; OPS_EVIDENCE="$2"; mkdir -p "$OPS_EVIDENCE"; calls="$3"
record() { printf '%s\n' "$1" >>"$calls"; }
ops_install_candidate() { record install; }
ops_install_control_plane() { record control-plane; }
ops_create_project_workspace() { record create-workspace; OPS_WORKSPACE_CREATED=1; }
ops_start_services() { record start; }
ops_read_protected_ref() { printf '%s\n' "$PROJECT_COMMIT"; }
ops_create_proposal() { local attempt="$1" c; c="$(printf "$attempt%.0s" {1..40})"; printf '{"proposalRef":"refs/heads/proposals/ws/run-%s","candidateCommit":"%s","candidateTree":"%s"}\n' "$attempt" "$c" "$(printf 'f%.0s' {1..40})"; }
ops_read_envelope() { local proposal="$1" review; review="$(jq -r .candidateCommit <<<"$proposal" | sha256sum | cut -d ' ' -f 1)"; printf '{"reviewId":"%s","proposalRef":"%s","candidateCommit":"%s","candidateTree":"%s","expectedProtectedHead":"%s"}\n' "$review" "$(jq -r .proposalRef <<<"$proposal")" "$(jq -r .candidateCommit <<<"$proposal")" "$(jq -r .candidateTree <<<"$proposal")" "$PROJECT_COMMIT"; }
ops_wait_terminal_evidence() { printf '{"ordinary":{"result":"success"},"qemu":{"result":"success"}}\n'; }
ops_wait_idle() { record idle; }
ops_restart_services() { record restart; }
ops_execute
`;
  const root = await temporaryRoot();
  const calls = join(root, "calls");
  await exec("bash", ["-c", driver, "bash", runLibrary, join(root, "evidence"), calls]);

  assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"),
    ["install", "control-plane", "create-workspace", "start", "idle", "restart", "idle"]);
  const attempts = JSON.parse(await readFile(join(root, "evidence", "attempts.json"), "utf8"));
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].candidateCommit, attempts[1].candidateCommit);
  const source = await readFile(runLibrary, "utf8");
  assert.doesNotMatch(source, /review (resolve|inspect|approve|promote)|PROMOTER|REVIEWER/);
});

test("restarts idle workers before the scheduler and requires all InvocationIDs to change", async () => {
  const root = await temporaryRoot();
  const calls = join(root, "calls");
  const evidence = join(root, "evidence");
  const driver = String.raw`
set -euo pipefail
source "$1"
declare -A OPS_CONFIG=([CONTROL_SSH]=control [ORDINARY_SSH]=ordinary
  [QEMU_SCHEDULER_UNIT]=scheduler.service [QEMU_HOST_UNIT]=qemu.service [ORDINARY_UNIT]=ordinary.service)
OPS_EVIDENCE="$2"; mkdir -p "$OPS_EVIDENCE"; calls="$3"; showfile="$4"; printf '0\n' >"$showfile"
ops_ssh() {
  local target="$1"; shift; printf '%s %s\n' "$target" "$*" >>"$calls"
}
ops_invocation_ids() { local count; count="$(<"$showfile")"; count=$((count + 1)); printf '%s\n' "$count" >"$showfile";
  if [[ "$count" -eq 1 ]]; then printf '%s\n' '{"scheduler":"11111111111111111111111111111111","qemuHost":"22222222222222222222222222222222","ordinary":"33333333333333333333333333333333"}';
  else printf '%s\n' '{"scheduler":"44444444444444444444444444444444","qemuHost":"55555555555555555555555555555555","ordinary":"66666666666666666666666666666666"}'; fi; }
ops_assert_owned_idle() { printf 'post-stop-idle\n' >>"$calls"; }
ops_wait_scheduler() { printf 'scheduler-ready\n' >>"$calls"; }
ops_restart_services
`;

  await exec("bash", ["-c", driver, "bash", cleanupLibrary, evidence, calls, join(root, "shows")]);

  const lines = (await readFile(calls, "utf8")).trim().split("\n");
  assert.match(lines[0], /^ordinary .* stop ordinary\.service$/);
  assert.match(lines[1], /^control .* stop qemu\.service$/);
  assert.match(lines[2], /^control .* stop scheduler\.service$/);
  assert.equal(lines[3], "post-stop-idle");
  assert.match(lines[4], /^control .* start scheduler\.service$/);
  assert.equal(lines[5], "scheduler-ready");
  assert.match(lines[6], /^control .* start qemu\.service$/);
  assert.match(lines[7], /^ordinary .* start ordinary\.service$/);
  const invocationIds = JSON.parse(await readFile(join(evidence, "restart-invocation-ids.json"), "utf8"));
  assert.notEqual(invocationIds.before.scheduler, invocationIds.after.scheduler);
  assert.notEqual(invocationIds.before.qemuHost, invocationIds.after.qemuHost);
  assert.notEqual(invocationIds.before.ordinary, invocationIds.after.ordinary);
  assert.match(await readFile(cleanupLibrary, "utf8"), /--property=InvocationID/);
});

test("publishes OPS-PASSED only after exact cleanup and returns 125 on uncertain cleanup", async () => {
  const root = await temporaryRoot();
  const successEvidence = join(root, "success");
  const failedEvidence = join(root, "failed");
  const driver = String.raw`
set -euo pipefail
source "$1"
OPS_EVIDENCE="$2"; mkdir -m 700 -p "$OPS_EVIDENCE"
declare -A OPS_CONFIG=([EXPECTED_COMMIT]="$(printf 'a%.0s' {1..40})" [PROJECT_COMMIT]="$(printf 'b%.0s' {1..40})")
OPS_WORKSPACE_CREATED=1; OPS_CLEANUP_COMPLETE=0; FAIL_CLEANUP="$FAIL_CLEANUP"
ops_stop_armed_services() { printf 'stopped\n' >>"$OPS_EVIDENCE/order"; }
ops_discard_owned_workspace() { printf 'discarded\n' >>"$OPS_EVIDENCE/order"; [[ "$FAIL_CLEANUP" == 0 ]]; }
ops_assert_owned_idle() { printf 'idle\n' >>"$OPS_EVIDENCE/order"; }
ops_cleanup_exact
ops_publish_passed '[]'
printf 'marker\n' >>"$OPS_EVIDENCE/order"
`;
  await exec("bash", ["-c", driver, "bash", cleanupLibrary, successEvidence], { env: { ...process.env, FAIL_CLEANUP: "0" } });
  const successOrder = (await readFile(join(successEvidence, "order"), "utf8")).trim().split("\n");
  assert.deepEqual(successOrder, ["stopped", "discarded", "idle", "marker"]);
  assert.equal(JSON.parse(await readFile(join(successEvidence, "OPS-PASSED"), "utf8")).scope,
    "prestable-two-node-control-qemu-plus-ordinary-operations");

  const failure = await execFailure("bash", ["-c", driver, "bash", cleanupLibrary, failedEvidence], { ...process.env, FAIL_CLEANUP: "1" });
  assert.equal(failure.code, 125);
  await assert.rejects(readFile(join(failedEvidence, "OPS-PASSED")));
});

test("propagates control idle failure even when ordinary idle succeeds", async () => {
  const driver = String.raw`
set -euo pipefail
source "$1"
declare -A OPS_CONFIG=([CONTROL_SSH]=control [ORDINARY_SSH]=ordinary
  [QEMU_HOST_CONFIG]=/qemu.json [QEMU_HOST_ID]=qemu-a [ORDINARY_STATE_DIRECTORY]=/ordinary)
ops_ssh() { [[ "$1" != control ]]; }
if ops_assert_owned_idle; then exit 99; else exit 7; fi
`;

  const result = await execFailure("bash", ["-c", driver, "bash", cleanupLibrary]);

  assert.equal(result.code, 7);
});

test("keeps a failed workspace creation attempt armed when discard inspection fails", async () => {
  const driver = String.raw`
set -euo pipefail
source "$1"
declare -A OPS_CONFIG=([CONTROL_SSH]=control [CONTROL_PLANE_CONNECTION]=/control.json
  [WORKSPACE_NAME]=ops-workspace [PROJECT_NAME]=ops-project [PROJECT_ID]=ops-project)
OPS_WORKSPACE_CREATION_ATTEMPTED=1; OPS_WORKSPACE_CREATED=0
ops_ssh() { return 9; }
status=0; ops_discard_owned_workspace || status=$?
printf '%s:%s:%s\n' "$status" "$OPS_WORKSPACE_CREATION_ATTEMPTED" "$OPS_WORKSPACE_CREATED"
`;

  const result = await exec("bash", ["-c", driver, "bash", cleanupLibrary]);

  assert.equal(result.stdout.trim(), "9:1:0");
});

async function configFixture() {
  const root = await temporaryRoot();
  const evidence = join(root, "evidence");
  const config = join(root, "operator.conf");
  const paths = ["CONTROL_SOURCE_ROOT", "ORDINARY_SOURCE_ROOT", "CONTROL_INSTALL_CONFIG", "PROJECT_SOURCE",
    "REGISTRAR_CONNECTION", "IMPORTER_CONNECTION", "CONTROL_PLANE_CONNECTION", "WORKSPACE_REPOSITORY",
    "ORDINARY_HOST_CONFIG", "ORDINARY_STATE_DIRECTORY", "QEMU_SCHEDULER_CONFIG", "QEMU_HOST_CONFIG"];
  const values = {
    CONTROL_SSH: "control", ORDINARY_SSH: "ordinary", EXPECTED_COMMIT: "a".repeat(40), PROJECT_NAME: "ops-project",
    PROJECT_ID: "ops-project", PROJECT_REF: "refs/heads/main", PROJECT_COMMIT: "b".repeat(40), WORKSPACE_NAME: "ops-workspace",
    ORDINARY_HOST_ID: "ordinary-a", ORDINARY_UNIT: "dim-ordinary.service", QEMU_HOST_ID: "qemu-a",
    QEMU_SCHEDULER_UNIT: "dim-qemu-scheduler.service", QEMU_HOST_UNIT: "dim-qemu-host.service",
    NATIVE_GIT_CONTAINER: "dim-native-git", ORDINARY_CI_CONTAINER: "dim-ordinary-ci", ORDINARY_JOB: "source",
    QEMU_JOB: "integration", ORDINARY_MARKER: "ordinary-ok", QEMU_MARKER: "qemu-ok", EVIDENCE_DIR: evidence,
    PROTECTED_QEMU_MODE: "unused", DISPOSABLE_EXCLUSIVE_NODES_ACK: "control-qemu-and-ordinary"
  };
  for (const key of paths) values[key] = join(root, key.toLowerCase());
  await writeFile(config, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
  return { config, evidence };
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "dim-native-operations-test-"));
  temporaryRoots.push(root);
  return root;
}

async function execFailure(file, args, env = process.env) {
  try { await exec(file, args, { env }); } catch (error) {
    if (error instanceof Error && "code" in error && "stderr" in error) return error;
    throw error;
  }
  throw new Error("command unexpectedly succeeded");
}
