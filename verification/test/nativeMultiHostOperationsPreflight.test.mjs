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
const script = join(verificationRoot, "scripts", "native-multi-host-operations.bash");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("preflight fake SSH exercises both nodes without persistent operation commands", async () => {
  const fixture = await fakeSshFixture("success");

  const result = await exec("bash", [script, "--preflight-only", fixture.config], { env: fixture.env });

  assert.match(result.stdout, /bounded probes only/);
  await assert.rejects(stat(fixture.evidence));
  const log = await readFile(fixture.log, "utf8");
  assert.match(log, /target=control count=1/);
  assert.match(log, /target=control count=4/);
  assert.match(log, /target=ordinary count=3/);
  assert.doesNotMatch(log, /just install-local|installer install|project bootstrap|workspace create|systemctl --user start/);
  assert.match(log, /dim-native-cutover-probe/);
  assert.match(log, /--property=ActiveState --value/);
  assert.match(log, /--property=ExecStart --value/);
  assert.doesNotMatch(log, /systemctl --user (?:cat|is-active)/);
});

test("preflight fake SSH fails closed on duplicate host identity without creating evidence", async () => {
  const fixture = await fakeSshFixture("duplicate");

  const result = await execFailure("bash", [script, "--preflight-only", fixture.config], fixture.env);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /nodes share machineId/);
  await assert.rejects(stat(fixture.evidence));
});

test("preflight fake SSH propagates a host-state probe failure without persistent cleanup", async () => {
  const fixture = await fakeSshFixture("state-failure");

  const result = await execFailure("bash", [script, "--preflight-only", fixture.config], fixture.env);

  assert.notEqual(result.code, 0);
  await assert.rejects(stat(fixture.evidence));
  const log = await readFile(fixture.log, "utf8");
  assert.doesNotMatch(log, /workspace discard|systemctl --user stop/);
});

async function fakeSshFixture(mode) {
  const root = await mkdtemp(join(tmpdir(), "dim-native-operations-ssh-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const log = join(root, "ssh.log");
  const evidence = join(root, "evidence");
  const config = join(root, "operator.conf");
  await mkdir(bin);
  await mkdir(state);
  await writeFile(join(bin, "ssh"), `#!/usr/bin/env bash
set -euo pipefail
while [[ "$1" != -- ]]; do shift; done
shift; target="$1"; shift
count_file="$OPS_TEST_STATE/$target.count"
count=0; [[ ! -f "$count_file" ]] || count="$(<"$count_file")"
count=$((count + 1)); printf '%s\n' "$count" >"$count_file"
payload="$(cat)"
printf 'target=%s count=%s argv=%q payload=%s\n' "$target" "$count" "$*" "$payload" >>"$OPS_TEST_LOG"
[[ "$OPS_TEST_MODE" != state-failure || "$target" != control || "$payload" != *'projects='* ]] || exit 9
if [[ "$payload" == *'prepared_state='* ]]; then
  machine="$target"; [[ "$OPS_TEST_MODE" != duplicate ]] || machine=same
  jq -cn --arg machine "$machine" --arg target "$target" '{role:$target,hostname:$target,machineId:$machine,
    bootId:("boot-"+$machine),dockerId:("docker-"+$machine),stateIdentity:("state-"+$machine),
    sourceRoot:("/srv/"+$target),commit:("a"*40),dimVersion:"0.9.0",aggregateLockSha256:("b"*64),
    packageSha256:("c"*64),preparedImageRef:("image@sha256:"+("d"*64)),preparedImageId:("sha256:"+("e"*64))}'
elif [[ "$payload" == *'kind="$1"'* ]]; then
  [[ "$target" == control ]] && printf 'qemu-a\n' || printf 'ordinary-a\n'
fi
`, { mode: 0o755 });
  const values = {
    CONTROL_SSH: "control", ORDINARY_SSH: "ordinary", EXPECTED_COMMIT: "a".repeat(40),
    CONTROL_SOURCE_ROOT: "/srv/control", ORDINARY_SOURCE_ROOT: "/srv/ordinary",
    CONTROL_INSTALL_CONFIG: "/etc/dim/install.json", PROJECT_NAME: "ops-project", PROJECT_ID: "ops-project",
    PROJECT_SOURCE: "/srv/project", PROJECT_REF: "refs/heads/main", PROJECT_COMMIT: "f".repeat(40),
    REGISTRAR_CONNECTION: "/etc/dim/registrar.json", IMPORTER_CONNECTION: "/etc/dim/importer.json",
    CONTROL_PLANE_CONNECTION: "/etc/dim/control.json", WORKSPACE_NAME: "ops-workspace",
    WORKSPACE_REPOSITORY: "/workspace/root", ORDINARY_HOST_CONFIG: "/etc/dim/ordinary.json",
    ORDINARY_HOST_ID: "ordinary-a", ORDINARY_UNIT: "dim-ordinary.service",
    ORDINARY_STATE_DIRECTORY: "/var/lib/dim-ordinary", QEMU_SCHEDULER_CONFIG: "/etc/dim/qemu-scheduler.json",
    QEMU_HOST_CONFIG: "/etc/dim/qemu-host.json", QEMU_HOST_ID: "qemu-a",
    QEMU_SCHEDULER_UNIT: "dim-qemu-scheduler.service", QEMU_HOST_UNIT: "dim-qemu-host.service",
    NATIVE_GIT_CONTAINER: "dim-native-git", ORDINARY_CI_CONTAINER: "dim-ordinary-ci",
    ORDINARY_JOB: "source", QEMU_JOB: "integration", ORDINARY_MARKER: "ordinary-ok", QEMU_MARKER: "qemu-ok",
    EVIDENCE_DIR: evidence, PROTECTED_QEMU_MODE: "unused",
    DISPOSABLE_EXCLUSIVE_NODES_ACK: "control-qemu-and-ordinary"
  };
  await writeFile(config, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
  return { config, evidence, log, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    OPS_TEST_LOG: log, OPS_TEST_MODE: mode, OPS_TEST_STATE: state } };
}

async function execFailure(file, args, env) {
  try { await exec(file, args, { env }); } catch (error) {
    if (error instanceof Error && "code" in error && "stderr" in error) return error;
    throw error;
  }
  throw new Error("command unexpectedly succeeded");
}
