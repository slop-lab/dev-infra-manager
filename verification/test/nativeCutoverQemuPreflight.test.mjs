import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";

const exec = promisify(execFile);
const verificationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonLibrary = join(verificationRoot, "scripts", "lib", "native-cutover-clean-host-common.bash");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("host KVM probe completes through the ordered QMP quit handshake", async () => {
  // Given
  const fixture = await qmpFixture("enabled");

  // When
  const result = await runProbe("cutover_native_qemu_kvm_probe", fixture.env);

  // Then
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(qmpCommands(await readFile(fixture.qmpLog, "utf8")), [
    { execute: "qmp_capabilities", id: "caps" },
    { execute: "query-kvm", id: "kvm" },
    { execute: "quit", id: "quit" }
  ]);
});

test("runner KVM probe completes through QMP and retains the image mount-independent Docker boundary", async () => {
  // Given
  const fixture = await qmpFixture("enabled");

  // When
  await runProbe("cutover_native_qemu_runner_probe test-runner-image", fixture.env);

  // Then
  assert.deepEqual(qmpCommands(await readFile(fixture.qmpLog, "utf8")), [
    { execute: "qmp_capabilities", id: "caps" },
    { execute: "query-kvm", id: "kvm" },
    { execute: "quit", id: "quit" }
  ]);
  const calls = await dockerCalls(fixture.dockerLog);
  const run = calls.find(([command]) => command === "run");
  assert.ok(run?.includes("--pull") && run.includes("never"));
  assert.ok(run.includes("--device") && run.includes("/dev/kvm:/dev/kvm"));
  assert.ok(run.includes("--name") && run.some((argument) => argument.startsWith("org.dim.native-cutover-probe=")));
  const inspect = calls.find((arguments_) => arguments_[0] === "container" && arguments_[1] === "inspect");
  const remove = calls.find((arguments_) => arguments_[0] === "container" && arguments_[1] === "rm");
  assert.equal(inspect?.at(-1), run[run.indexOf("--name") + 1]);
  assert.equal(remove?.at(-1), "a".repeat(64));
});

test("KVM probe fails closed when QMP reports acceleration disabled", async () => {
  // Given
  const fixture = await qmpFixture("disabled");

  // When
  const result = await runProbeFailure("cutover_native_qemu_kvm_probe", fixture.env);

  // Then
  assert.notEqual(result.code, 0);
  assert.deepEqual(qmpCommands(await readFile(fixture.qmpLog, "utf8")).map(({ id }) => id), ["caps", "kvm", "quit"]);
});

test("KVM probe rejects QMP errors and duplicate command responses", async () => {
  // Given / When
  const errorFixture = await qmpFixture("error");
  const duplicateFixture = await qmpFixture("duplicate");
  const qmpError = await runProbeFailure("cutover_native_qemu_kvm_probe", errorFixture.env);
  const duplicate = await runProbeFailure("cutover_native_qemu_kvm_probe", duplicateFixture.env);

  // Then
  assert.notEqual(qmpError.code, 0);
  assert.notEqual(duplicate.code, 0);
});

test("host probe rejects valid QMP replies when the process does not complete", async () => {
  // Given
  const fixture = await qmpFixture("reply-hang");

  // When
  const result = await runProbeFailure("cutover_native_qemu_kvm_probe", fixture.env);

  // Then
  assert.notEqual(result.code, 0);
  assert.ok((await timeoutCalls(fixture.timeoutLog)).some((arguments_) =>
    arguments_[0] === "-s" && arguments_[1] === "KILL" && arguments_[2] === "5"));
}, 8_000);

test("root-image checks are bounded and clean their owned probe container", async () => {
  // Given
  const fixture = await qmpFixture("enabled", "root-hang");
  const startedAt = Date.now();

  // When
  const result = await runProbeFailure(
    "cutover_native_qemu_root_probe test-runner-image test-root-image",
    fixture.env
  );

  // Then
  const elapsed = Date.now() - startedAt;
  assert.notEqual(result.code, 0);
  assert.ok(elapsed >= 10_000 && elapsed < 13_000, `root probe took ${elapsed}ms`);
  const calls = await dockerCalls(fixture.dockerLog);
  assert.ok(calls.some((arguments_) => arguments_.includes("type=image,src=test-root-image,dst=/run/dim/guest-root")));
  assert.ok(calls.some((arguments_) => arguments_[0] === "container" && arguments_[1] === "rm"));
}, 15_000);

test("runner probe fails when owned cleanup fails and never removes a foreign collision", async () => {
  // Given
  const cleanupFailureFixture = await qmpFixture("enabled", "cleanup-fail");
  const foreignFixture = await qmpFixture("enabled", "foreign");

  // When
  const cleanupFailure = await runProbeFailure(
    "cutover_native_qemu_runner_probe test-runner-image",
    cleanupFailureFixture.env
  );
  const foreign = await runProbeFailure("cutover_native_qemu_runner_probe test-runner-image", foreignFixture.env);

  // Then
  assert.notEqual(cleanupFailure.code, 0);
  assert.notEqual(foreign.code, 0);
  const foreignCalls = await dockerCalls(foreignFixture.dockerLog);
  assert.ok(foreignCalls.some((arguments_) => arguments_[0] === "container" && arguments_[1] === "inspect"));
  assert.equal(foreignCalls.some((arguments_) => arguments_[0] === "container" && arguments_[1] === "rm"), false);
});

test("catchable interruption preserves signal failure and removes the owned probe", async () => {
  // Given
  const fixture = await qmpFixture("enabled", "interrupt");
  const child = spawn("bash", ["-c",
    'set -euo pipefail; source "$1"; cutover_native_qemu_docker_probe 10 image true',
    "bash", commonLibrary], { env: fixture.env, detached: true, stdio: "ignore" });
  assert.notEqual(child.pid, undefined);
  await waitForFile(fixture.dockerState);

  // When
  const descendants = await descendantProcessIds(child.pid);
  for (const processId of descendants.reverse()) {
    try {
      process.kill(processId, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  // Then
  assert.ok(outcome.code === 143 || outcome.signal === "SIGTERM");
  await waitForDockerRemoval(fixture.dockerLog);
  const calls = await dockerCalls(fixture.dockerLog);
  assert.ok(calls.some((arguments_) => arguments_[0] === "container" && arguments_[1] === "inspect"));
  assert.equal(calls.find((arguments_) => arguments_[0] === "container" && arguments_[1] === "rm")?.at(-1),
    "a".repeat(64));
}, 5_000);

test("probe signal traps do not replace caller traps", async () => {
  // Given
  const fixture = await qmpFixture("enabled");
  const invocation = `
trap 'exit 77' TERM
before="$(trap -p TERM)"
cutover_native_qemu_docker_probe 10 image true >/dev/null
[[ "$(trap -p TERM)" == "$before" ]]
`;

  // When
  const result = await runProbe(invocation, fixture.env);

  // Then
  assert.equal(result.stderr, "");
});

test("host and runner probes terminate their stand-ins when normal completion never arrives", async () => {
  // Given
  const hostFixture = await qmpFixture("hang");
  const runnerFixture = await qmpFixture("enabled", "hang");

  // When
  const startedAt = Date.now();
  const host = await runProbeFailure("cutover_native_qemu_kvm_probe", hostFixture.env);
  const hostElapsed = Date.now() - startedAt;
  const runnerStartedAt = Date.now();
  const runner = await runProbeFailure("cutover_native_qemu_runner_probe test-runner-image", runnerFixture.env);
  const runnerElapsed = Date.now() - runnerStartedAt;

  // Then
  assert.notEqual(host.code, 0);
  assert.ok(hostElapsed >= 5_000, `host probe returned before its timeout after ${hostElapsed}ms`);
  assert.ok(hostElapsed < 8_000, `host probe took ${hostElapsed}ms`);
  assert.notEqual(runner.code, 0);
  assert.ok(runnerElapsed >= 10_000, `runner probe returned before its timeout after ${runnerElapsed}ms`);
  assert.ok(runnerElapsed < 13_000, `runner probe took ${runnerElapsed}ms`);
}, 25_000);

async function qmpFixture(qemuMode, dockerMode = "run") {
  const root = await mkdtemp(join(tmpdir(), "dim-cutover-qmp-test-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const qmpLog = join(root, "qmp.log");
  const dockerLog = join(root, "docker.log");
  const timeoutLog = join(root, "timeout.log");
  const dockerState = join(root, "docker.state");
  await mkdir(bin);
  await writeFile(join(bin, "qemu-system-x86_64"), `#!/usr/bin/env bash
set -euo pipefail
payload="$(cat)"
printf '%s\\n' "$payload" >"$QMP_TEST_LOG"
mapfile -t commands <<<"$payload"
if [[ "\${commands[2]:-}" != '{"execute":"quit","id":"quit"}' ]]; then trap '' TERM; exec sleep 30; fi
if [[ "$QMP_TEST_QEMU_MODE" == hang ]]; then trap '' TERM; exec sleep 30; fi
printf '%s\\n' '{"QMP":{"version":{"qemu":{"major":9,"minor":0,"micro":0},"package":""},"capabilities":[]}}'
printf '%s\\n' '{"return":{},"id":"caps"}'
if [[ "$QMP_TEST_QEMU_MODE" == error ]]; then
  printf '%s\\n' '{"error":{"class":"GenericError","desc":"probe failed"},"id":"kvm"}'
elif [[ "$QMP_TEST_QEMU_MODE" == enabled || "$QMP_TEST_QEMU_MODE" == duplicate ]]; then
  printf '%s\\n' '{"return":{"enabled":true,"present":true},"id":"kvm"}'
else
  printf '%s\\n' '{"return":{"enabled":false,"present":true},"id":"kvm"}'
fi
if [[ "$QMP_TEST_QEMU_MODE" == duplicate ]]; then
  printf '%s\\n' '{"return":{"enabled":true,"present":true},"id":"kvm"}'
fi
printf '%s\\n' '{"return":{},"id":"quit"}'
if [[ "$QMP_TEST_QEMU_MODE" == reply-hang ]]; then trap 'exit 0' TERM; sleep 30; fi
`, { mode: 0o755 });
  await writeFile(join(bin, "timeout"), `#!/usr/bin/env bash
set -uo pipefail
printf '%s\\n' "$(printf '%s\\n' "$@" | jq -Rsc 'split("\\n")[:-1]')" >>"$QMP_TEST_TIMEOUT_LOG"
if [[ "\${1:-}" == -s && "\${2:-}" == KILL ]]; then exec /usr/bin/timeout "$@"; fi
if output="$(/usr/bin/timeout "$@")"; then status=0; else status=$?; fi
printf '%s\\n' "$output"
if [[ "$output" == *'"id":"quit"'* ]]; then exit 0; fi
exit "$status"
`, { mode: 0o755 });
  await writeFile(join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$(printf '%s\\n' "$@" | jq -Rsc 'split("\\n")[:-1]')" >>"$QMP_TEST_DOCKER_LOG"
case "\${1:-} \${2:-}" in
  'container inspect')
    [[ -f "$QMP_TEST_DOCKER_STATE" ]] || exit 1
    IFS=: read -r name owner id <"$QMP_TEST_DOCKER_STATE"
    [[ "\${@: -1}" == "$name" ]] || exit 1
    printf '%s\\n%s\\n/%s\\n' "$id" "$owner" "$name"
    ;;
  'container rm')
    [[ "$QMP_TEST_DOCKER_MODE" != cleanup-fail ]] || exit 9
    IFS=: read -r _ _ id <"$QMP_TEST_DOCKER_STATE"
    [[ "\${@: -1}" == "$id" ]] || exit 8
    rm "$QMP_TEST_DOCKER_STATE"
    printf '%s\\n' "$id"
    ;;
  *)
    name=''; owner=''
    arguments=("$@")
    for ((index=0; index < \${#arguments[@]}; index++)); do
      [[ "\${arguments[index]}" == --name ]] && name="\${arguments[index + 1]}"
      [[ "\${arguments[index]}" == --label ]] && owner="\${arguments[index + 1]#*=}"
    done
    if [[ -n "$name" ]]; then
      [[ "$QMP_TEST_DOCKER_MODE" != foreign ]] || owner=foreign
      printf '%s:%s:%s\\n' "$name" "$owner" '${"a".repeat(64)}' >"$QMP_TEST_DOCKER_STATE"
    fi
    [[ "$QMP_TEST_DOCKER_MODE" != foreign ]] || exit 125
    if [[ "$QMP_TEST_DOCKER_MODE" == interrupt ]]; then
      sleep 30
    elif [[ "$QMP_TEST_DOCKER_MODE" == hang ||
          ("$QMP_TEST_DOCKER_MODE" == root-hang && "$*" == *type=image*) ]]; then
      trap '' TERM; exec sleep 30
    fi
    bash -ec "test() { return 0; }
\${@: -1}"
    ;;
esac
`, { mode: 0o755 });
  return {
    qmpLog,
    dockerLog,
    dockerState,
    timeoutLog,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      QMP_TEST_LOG: qmpLog,
      QMP_TEST_QEMU_MODE: qemuMode,
      QMP_TEST_DOCKER_LOG: dockerLog,
      QMP_TEST_DOCKER_MODE: dockerMode,
      QMP_TEST_DOCKER_STATE: dockerState,
      QMP_TEST_TIMEOUT_LOG: timeoutLog
    }
  };
}

async function runProbe(invocation, env) {
  return exec("bash", ["-c", `set -euo pipefail; source "$1"; ${invocation}`, "bash", commonLibrary], { env });
}

async function runProbeFailure(invocation, env) {
  try {
    await runProbe(invocation, env);
  } catch (error) {
    if (error instanceof Error && "code" in error) return error;
    throw error;
  }
  throw new Error("probe unexpectedly succeeded");
}

function qmpCommands(source) {
  return source.trim().split("\n").map((line) => JSON.parse(line));
}

async function dockerCalls(path) {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

async function timeoutCalls(path) {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForDockerRemoval(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const calls = await dockerCalls(path);
    if (calls.some((arguments_) => arguments_[0] === "container" && arguments_[1] === "rm")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for owned probe removal");
}

async function descendantProcessIds(processId) {
  const source = await readFile(`/proc/${processId}/task/${processId}/children`, "utf8");
  const children = source.trim() === "" ? [] : source.trim().split(" ").map(Number);
  const descendants = [];
  for (const child of children) descendants.push(child, ...await descendantProcessIds(child));
  return descendants;
}
