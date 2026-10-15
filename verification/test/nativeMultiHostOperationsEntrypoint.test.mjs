import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";

const exec = promisify(execFile);
const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(verificationRoot, "scripts", "native-multi-host-operations.bash");
const loggedRunner = join(verificationRoot, "scripts", "run-native-multi-host-operations-with-log.bash");
const sshFixture = join(verificationRoot, "test", "fixtures", "native-multi-host-operations-ssh.mjs");
const roots = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test("logged operator wrapper preserves config secrecy and orders plan, preflight, and execution", async () => {
  const script = await readFile(loggedRunner, "utf8");

  assert.match(script, /chmod 0600 -- "\$log_path"/);
  assert.match(script, /contents intentionally not logged/);
  assert.doesNotMatch(script, /(?:cat|source)\s+(?:--\s+)?"?\$config_path/);
  const plan = script.indexOf("--print-command-plan");
  const preflight = script.indexOf("native-multi-host-operations-preflight");
  const execution = script.indexOf('native-multi-host-operations "$config_path"');
  assert.ok(plan >= 0 && plan < preflight && preflight < execution);
  assert.match(script, /operations command returned success without OPS-PASSED/);
});

test("full entrypoint runs two real proposal/evidence paths around restart and publishes after cleanup", async () => {
  const fixture = await entrypointFixture("success");

  const result = await execObserved(fixture);

  assert.match(result.stdout, /operations passed/);
  const passed = JSON.parse(await readFile(join(fixture.evidence, "OPS-PASSED"), "utf8"));
  assert.equal(passed.attempts.length, 2);
  assert.notEqual(passed.attempts[0].candidateCommit, passed.attempts[1].candidateCommit);
  const nodes = JSON.parse(await readFile(join(fixture.evidence, "nodes.json"), "utf8"));
  assert.notEqual(nodes.controlQemu.preparedImageId, nodes.ordinary.preparedImageId);
  assert.match(nodes.controlQemu.preparedImageId, /^sha256:[0-9a-f]{64}$/);
  assert.match(nodes.ordinary.preparedImageId, /^sha256:[0-9a-f]{64}$/);
  const calls = (await readFile(fixture.log, "utf8")).trim().split("\n").map(JSON.parse);
  const install = calls.findIndex(({ command }) => command.includes("installer") && command.includes("control-plane"));
  const restart = calls.findIndex(({ command }) => command.includes("controller") && command.includes("restart"));
  const bootstrap = calls.findIndex(({ payload }) => payload.includes("bootstrap-native-root"));
  assert.ok(install >= 0 && restart > install && bootstrap > restart);
  assert.equal(calls.filter(({ payload }) => payload.includes('proposal="refs/heads/proposals')).length, 2);
  assert.equal(calls.filter(({ command }) => command[0] === "docker" && command[1] === "exec"
    && command.includes("--interactive")).length, 4);
  const systemd = calls.filter(({ command }) => command[0] === "systemctl").map(({ target, command }) => `${target}:${command.join(" ")}`);
  assert.ok(systemd.indexOf("ordinary:systemctl --user stop ordinary.service")
    < systemd.indexOf("control:systemctl --user stop scheduler.service"));
  assert.ok(systemd.indexOf("control:systemctl --user start scheduler.service")
    < systemd.indexOf("control:systemctl --user start qemu.service"));
}, 30_000);

test("workspace partial failure plus control idle failure returns 125 and never publishes marker", async () => {
  const fixture = await entrypointFixture("setup-failure");

  const result = await execFailure("bash", [runner, fixture.config], fixture.env);

  assert.equal(result.code, 125);
  assert.match(result.stderr, /cleanup ownership or completion is uncertain/);
  await assert.rejects(readFile(join(fixture.evidence, "OPS-PASSED")));
  await assert.rejects(stat(join(fixture.state, "workspace.json")));
}, 30_000);

async function entrypointFixture(mode) {
  const root = await mkdtemp(join(tmpdir(), "dim-native-operations-entrypoint-"));
  roots.push(root);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const repository = join(root, "repository");
  const log = join(root, "ssh.jsonl");
  const evidence = join(root, "evidence");
  const config = join(root, "operator.conf");
  await mkdir(bin); await mkdir(state); await mkdir(repository);
  await copyFile(sshFixture, join(bin, "ssh")); await chmod(join(bin, "ssh"), 0o755);
  const values = {
    CONTROL_SSH: "control", ORDINARY_SSH: "ordinary", EXPECTED_COMMIT: "a".repeat(40),
    CONTROL_SOURCE_ROOT: "/srv/control", ORDINARY_SOURCE_ROOT: "/srv/ordinary", CONTROL_INSTALL_CONFIG: "/etc/dim/install.json",
    PROJECT_NAME: "ops-project", PROJECT_ID: "ops-project", PROJECT_SOURCE: "/srv/project", PROJECT_REF: "refs/heads/main",
    PROJECT_COMMIT: "f".repeat(40), REGISTRAR_CONNECTION: "/etc/dim/registrar.json", IMPORTER_CONNECTION: "/etc/dim/importer.json",
    CONTROL_PLANE_CONNECTION: "/etc/dim/control.json", WORKSPACE_NAME: "ops-workspace", WORKSPACE_REPOSITORY: "/workspace",
    ORDINARY_HOST_CONFIG: "/etc/dim/ordinary.json", ORDINARY_HOST_ID: "ordinary-a", ORDINARY_UNIT: "ordinary.service",
    ORDINARY_STATE_DIRECTORY: "/state/ordinary", QEMU_SCHEDULER_CONFIG: "/etc/dim/scheduler.json",
    QEMU_HOST_CONFIG: "/etc/dim/qemu.json", QEMU_HOST_ID: "qemu-a", QEMU_SCHEDULER_UNIT: "scheduler.service",
    QEMU_HOST_UNIT: "qemu.service", NATIVE_GIT_CONTAINER: "native-git", ORDINARY_CI_CONTAINER: "ordinary-ci",
    ORDINARY_JOB: "source", QEMU_JOB: "integration", ORDINARY_MARKER: "ordinary-ok", QEMU_MARKER: "qemu-ok",
    EVIDENCE_DIR: evidence, PROTECTED_QEMU_MODE: "unused", DISPOSABLE_EXCLUSIVE_NODES_ACK: "control-qemu-and-ordinary"
  };
  await writeFile(config, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
  return { config, evidence, log, state, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    OPS_FAKE_LOG: log, OPS_FAKE_MODE: mode, OPS_FAKE_STATE: state, OPS_FAKE_REPOSITORY: repository } };
}

async function execFailure(file, args, env) {
  try { await exec(file, args, { env, timeout: 20_000 }); } catch (error) {
    if (error instanceof Error && "code" in error && "stderr" in error) return error;
    throw error;
  }
  throw new Error("runner unexpectedly succeeded");
}

async function execObserved(fixture) {
  try {
    return await exec("timeout", ["-s", "KILL", "8", "bash", runner, fixture.config], { env: fixture.env });
  } catch (error) {
    const calls = await readFile(fixture.log, "utf8").catch(() => "<no SSH calls>");
    if (error instanceof Error) error.message += `\nSSH calls:\n${calls}`;
    throw error;
  }
}
