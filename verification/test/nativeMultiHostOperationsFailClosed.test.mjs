import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";

const exec = promisify(execFile);
const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonLibrary = join(verificationRoot, "scripts", "lib", "native-multi-host-operations-common.bash");
const runLibrary = join(verificationRoot, "scripts", "lib", "native-multi-host-operations-run.bash");
const cleanupLibrary = join(verificationRoot, "scripts", "lib", "native-multi-host-operations-cleanup.bash");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test.each([
  ["proposal", 7],
  ["envelope", 8],
  ["terminal evidence", 9]
])("attempt propagates nonzero %s status despite valid-looking JSON", async (stage, expectedStatus) => {
  const root = await temporaryRoot();
  const evidence = join(root, "evidence");
  await mkdir(evidence);

  const result = await exec("bash", ["-c", attemptDriver, "bash", runLibrary, evidence, stage]);

  assert.equal(result.stdout.trim(), String(expectedStatus));
  await assert.rejects(stat(join(evidence, "attempts.json")));
});

test("protected-ref read propagates ls-remote failure after valid-looking output", async () => {
  const root = await temporaryRoot();
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/usr/bin/env bash
printf '%s\t%s\n' '${"f".repeat(40)}' 'refs/heads/main'
exit 7
`, { mode: 0o755 });

  const result = await exec("bash", ["-c", protectedRefDriver, "bash", runLibrary], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  });

  assert.equal(result.stdout.trim(), "7");
});

test.each([
  ["control", 7],
  ["ordinary", 8]
])("InvocationID collection propagates nonzero %s SSH status", async (failedTarget, expectedStatus) => {
  const result = await exec("bash", ["-c", invocationDriver, "bash", cleanupLibrary, failedTarget]);

  assert.equal(result.stdout.trim(), String(expectedStatus));
});

test("ordinary preflight rejects a configured state directory that differs from the host config", async () => {
  const fixture = await ordinaryFixture();

  const result = await execFailure("bash", ["-c", ordinaryPreflightDriver, "bash", commonLibrary,
    fixture.config, fixture.inspectedState], fixture.env);

  assert.notEqual(result.code, 0);
});

test.each([
  ["missing", []],
  ["duplicate", ["source", "source"]],
  ["unsafe", ["../source"]]
])("ordinary preflight rejects %s configured capacities", async (_label, capacities) => {
  const fixture = await ordinaryFixture(capacities, true);

  const result = await execFailure("bash", ["-c", ordinaryPreflightDriver, "bash", commonLibrary,
    fixture.config, fixture.inspectedState], fixture.env);

  assert.notEqual(result.code, 0);
});

test("restart returns 125 without a marker when residue appears after workers stop", async () => {
  const root = await temporaryRoot();
  const evidence = join(root, "evidence");
  await mkdir(evidence);

  const result = await exec("bash", ["-c", restartResidueDriver, "bash", cleanupLibrary, evidence]);

  assert.equal(result.stdout.trim(), "125");
  await assert.rejects(stat(join(evidence, "OPS-PASSED")));
  await assert.rejects(stat(join(evidence, "restart-invocation-ids.json")));
});

const attemptDriver = String.raw`
set -euo pipefail
source "$1"
OPS_EVIDENCE="$2"; failed_stage="$3"
valid_proposal='{"proposalRef":"refs/heads/proposals/ws/run","candidateCommit":"1111111111111111111111111111111111111111","candidateTree":"2222222222222222222222222222222222222222"}'
valid_envelope='{"reviewId":"3333333333333333333333333333333333333333333333333333333333333333","expectedProtectedHead":"4444444444444444444444444444444444444444"}'
valid_terminal='{"ordinary":{"result":"success"},"qemu":{"result":"success"}}'
ops_create_proposal() { printf '%s\n' "$valid_proposal"; [[ "$failed_stage" != proposal ]] || return 7; }
ops_read_envelope() { printf '%s\n' "$valid_envelope"; [[ "$failed_stage" != envelope ]] || return 8; }
ops_wait_terminal_evidence() { printf '%s\n' "$valid_terminal"; [[ "$failed_stage" != 'terminal evidence' ]] || return 9; }
status=0; ops_execute_attempt 1 >/dev/null || status=$?
printf '%s\n' "$status"
`;

const protectedRefDriver = String.raw`
set -euo pipefail
source "$1"
declare -A OPS_CONFIG=([CONTROL_SSH]=control [CONTROL_PLANE_CONNECTION]=/control.json
  [WORKSPACE_NAME]=workspace [WORKSPACE_REPOSITORY]=/workspace [PROJECT_REF]=refs/heads/main)
ops_ssh() {
  shift
  local payload command
  payload="$(cat)"
  while [[ "$1" != bash ]]; do shift; done
  "$@" <<<"$payload"
}
status=0; ops_read_protected_ref >/dev/null || status=$?
printf '%s\n' "$status"
`;

const invocationDriver = String.raw`
set -euo pipefail
source "$1"
failed_target="$2"
declare -A OPS_CONFIG=([CONTROL_SSH]=control [ORDINARY_SSH]=ordinary
  [QEMU_SCHEDULER_UNIT]=scheduler.service [QEMU_HOST_UNIT]=qemu.service [ORDINARY_UNIT]=ordinary.service)
ops_ssh() {
  local target="$1"
  if [[ "$target" == control ]]; then
    printf '%s\n%s\n' '11111111111111111111111111111111' '22222222222222222222222222222222'
    [[ "$failed_target" != control ]] || return 7
  else
    printf '%s\n' '33333333333333333333333333333333'
    [[ "$failed_target" != ordinary ]] || return 8
  fi
}
status=0; ops_invocation_ids >/dev/null || status=$?
printf '%s\n' "$status"
`;

const ordinaryPreflightDriver = String.raw`
set -euo pipefail
source "$1"
declare -A OPS_CONFIG=([CONTROL_SSH]=control [ORDINARY_SSH]=ordinary [PROJECT_SOURCE]=/project
  [PROJECT_REF]=refs/heads/main [PROJECT_COMMIT]=ffffffffffffffffffffffffffffffffffffffff
  [CONTROL_PLANE_CONNECTION]=/control.json [PROJECT_NAME]=project [WORKSPACE_NAME]=workspace
  [QEMU_SCHEDULER_UNIT]=scheduler.service [QEMU_HOST_UNIT]=qemu.service
  [QEMU_SCHEDULER_CONFIG]=/scheduler.json [QEMU_HOST_CONFIG]=/qemu.json [QEMU_HOST_ID]=qemu-a
  [ORDINARY_UNIT]=ordinary.service [ORDINARY_HOST_CONFIG]="$2" [ORDINARY_STATE_DIRECTORY]="$3")
ops_assert_qemu_idle() { return 0; }
ops_ssh() {
  local target="$1" payload
  shift
  payload="$(cat)"
  [[ "$target" != control ]] || return 0
  "$@" <<<"$payload"
}
ops_state_preflight
`;

const restartResidueDriver = String.raw`
set -euo pipefail
source "$1"
OPS_EVIDENCE="$2"; stopped=0
declare -A OPS_CONFIG=([CONTROL_SSH]=control [ORDINARY_SSH]=ordinary [QEMU_SCHEDULER_UNIT]=scheduler.service
  [QEMU_HOST_UNIT]=qemu.service [ORDINARY_UNIT]=ordinary.service)
ops_invocation_ids() { printf '%s\n' '{"scheduler":"11111111111111111111111111111111","qemuHost":"22222222222222222222222222222222","ordinary":"33333333333333333333333333333333"}'; }
ops_ssh() { [[ "$*" != *' stop '* ]] || stopped=1; }
ops_assert_owned_idle() { [[ "$stopped" -eq 0 ]]; }
ops_wait_scheduler() { :; }
status=0; ops_restart_services || status=$?
printf '%s\n' "$status"
`;

async function ordinaryFixture(capacities = ["source"], matchingState = false) {
  const root = await temporaryRoot();
  const bin = join(root, "bin");
  const actualState = join(root, "actual-state");
  const inspectedState = join(root, "wrong-state");
  const config = join(root, "ordinary-host.json");
  await mkdir(bin); await mkdir(actualState); await mkdir(inspectedState);
  await writeFile(join(bin, "systemctl"), `#!/usr/bin/env bash
case "$*" in
  *LoadState*) printf 'loaded\n' ;;
  *ActiveState*) printf 'inactive\n' ;;
  *ExecStart*) printf 'dim ci native-root host run %s\n' "$OPS_TEST_ORDINARY_CONFIG" ;;
esac
`, { mode: 0o755 });
  await writeFile(join(bin, "docker"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  await writeFile(config, JSON.stringify({ schemaVersion: 1, hostId: "ordinary-a", generationId: "a".repeat(64),
    stateDirectory: actualState, gitExecutable: "/usr/bin/git",
    ordinaryCi: { transport: "loopback-http", endpoint: "http://127.0.0.1:9010", serviceId: "ordinary-main",
      credential: { username: "ordinary-a", password: "A".repeat(43) } },
    nativeGit: { transport: "loopback-http", endpoint: "http://127.0.0.1:9020", serviceId: "native-main" },
    capacities }));
  if (matchingState) return { config, inspectedState: actualState, env: { ...process.env,
    PATH: `${bin}:${process.env.PATH}`, OPS_TEST_ORDINARY_CONFIG: config } };
  return { config, inspectedState, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    OPS_TEST_ORDINARY_CONFIG: config } };
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "dim-native-operations-fail-closed-"));
  temporaryRoots.push(root);
  return root;
}

async function execFailure(file, args, env) {
  try { await exec(file, args, { env }); } catch (error) {
    if (error instanceof Error && "code" in error && "stderr" in error) return error;
    throw error;
  }
  throw new Error("command unexpectedly succeeded");
}
