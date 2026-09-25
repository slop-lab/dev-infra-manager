import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const runner = resolve(import.meta.dirname, "../scripts/lib/self-project-phase-runner.bash");
const smoke = resolve(import.meta.dirname, "../scripts/container-self-project-smoke.bash");
const behaviorDriver = resolve(import.meta.dirname, "../scripts/self-project-phase-runner-smoke.bash");
const sshFixture = resolve(import.meta.dirname, "../scripts/lib/container-self-project-ssh-fixture.bash");
const sshChecks = resolve(import.meta.dirname, "../scripts/lib/container-self-project-ssh-checks.bash");
const finalPhases = resolve(import.meta.dirname, "../scripts/lib/container-self-project-final-phases.bash");
const temporaryRoots: string[] = [];

type Driver = {
  readonly executionLog: string;
  readonly logRoot: string;
  readonly path: string;
};

async function createDriver(): Promise<Driver> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-self-phase-runner-"));
  temporaryRoots.push(root);
  const driver = resolve(root, "driver.bash");
  const executionLog = resolve(root, "executed");
  const logRoot = resolve(root, "logs");
  await writeFile(driver, `#!/usr/bin/env bash
set -euo pipefail
source "$1"
shift
execution_log="$DIM_PHASE_TEST_EXECUTION_LOG"
run_test_phase() {
  local phase="$1"
  printf '%s\\n' "$phase" >>"$execution_log"
  printf 'output-%s\\n' "$phase"
  case ",\${DIM_PHASE_TEST_FAILURES:-}," in
    *,"$phase",*) false; printf 'continued-%s\\n' "$phase" >>"$execution_log" ;;
  esac
}
phase_a() { run_test_phase a; }
phase_b() { run_test_phase b; }
phase_c() { run_test_phase c; }
phase_d() { run_test_phase d; }
phase_lifecycle() { run_test_phase lifecycle; }
self_phase_register a phase_a "" "first independent check"
self_phase_register b phase_b "a" "check requiring a"
self_phase_register c phase_c "" "second independent check"
self_phase_register d phase_d "" "later independent check"
self_phase_register lifecycle phase_lifecycle "a b c d" "destructive lifecycle"
self_phase_parse "$@"
self_phase_run
`);
  await chmod(driver, 0o700);
  return { executionLog, logRoot, path: driver };
}

function runDriver(driver: Driver, arguments_: readonly string[] = [], failures = "") {
  return spawnSync("/usr/bin/bash", [driver.path, runner, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      DIM_PHASE_LOG_ROOT: driver.logRoot,
      DIM_PHASE_TEST_EXECUTION_LOG: driver.executionLog,
      DIM_PHASE_TEST_FAILURES: failures
    }
  });
}

function runBehaviorDriver(driver: Driver, arguments_: readonly string[] = [], failures = "") {
  return spawnSync("/usr/bin/bash", [behaviorDriver, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      DIM_PHASE_DRIVER_EXECUTION_LOG: driver.executionLog,
      DIM_PHASE_DRIVER_FAILURES: failures,
      DIM_PHASE_LOG_ROOT: driver.logRoot
    }
  });
}

async function executed(driver: Driver): Promise<readonly string[]> {
  const content = await readFile(driver.executionLog, "utf8");
  return content.trim().split("\n");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("self-Project phase runner", () => {
  let driver: Driver;

  beforeEach(async () => {
    driver = await createDriver();
  });

  it("lists stable phase names without running or allocating logs", () => {
    // Given a registered phase graph
    // When
    const result = runDriver(driver, ["--list-phases"]);
    // Then
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n").map((line) => line.split("\t")[0])).toEqual([
      "a", "b", "c", "d", "lifecycle"
    ]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("destructive lifecycle");
  });

  it("rejects an unknown phase before running or allocating logs", () => {
    // Given an unknown selection
    // When
    const result = runDriver(driver, ["--phase", "unknown"]);
    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown self-Project phase: unknown");
    expect(result.stdout).toBe("");
  });

  it("reports independent failures, continues later checks, and skips dependents", async () => {
    // Given two failing independent phases
    // When
    const result = runDriver(driver, [], "a,c");
    // Then
    expect(result.status).toBe(1);
    expect(await executed(driver)).toEqual(["a", "c", "d"]);
    expect(result.stdout).toMatch(/FAIL\s+a\s+duration=/);
    expect(result.stdout).toMatch(/SKIP\s+b\s+dependency=a/);
    expect(result.stdout).toMatch(/FAIL\s+c\s+duration=/);
    expect(result.stdout).toMatch(/PASS\s+d\s+duration=/);
    expect(result.stdout).toMatch(/SKIP\s+lifecycle\s+dependency=/);
    expect(result.stdout).toContain("self-project-phase-summary passed=1 failed=2 skipped=2");
  });

  it("runs only selected independent phases", async () => {
    // Given a replay selection
    // When
    const result = runDriver(driver, ["--phase", "c", "--phase", "d"]);
    // Then
    expect(result.status).toBe(0);
    expect(await executed(driver)).toEqual(["c", "d"]);
    expect(result.stdout).not.toMatch(/(?:PASS|FAIL|SKIP)\s+(?:a|b|lifecycle)\b/);
  });

  it("runs a selected lifecycle when its failure barriers were not selected", async () => {
    // Given a lifecycle-only replay
    // When
    const result = runDriver(driver, ["--phase", "lifecycle"]);
    // Then
    expect(result.status).toBe(0);
    expect(await executed(driver)).toEqual(["lifecycle"]);
    expect(result.stdout).toMatch(/PASS\s+lifecycle\s+duration=/);
  });

  it("skips a selected dependent when its selected prerequisite fails", async () => {
    // Given a selected failing prerequisite and its dependent
    // When
    const result = runDriver(driver, ["--phase", "a", "--phase", "b"], "a");
    // Then
    expect(result.status).toBe(1);
    expect(await executed(driver)).toEqual(["a"]);
    expect(result.stdout).toMatch(/FAIL\s+a\s+duration=/);
    expect(result.stdout).toMatch(/SKIP\s+b\s+dependency=a/);
  });

  it("retains private per-phase evidence logs outside phase state", async () => {
    // Given one selected phase
    // When
    const result = runDriver(driver, ["--phase", "d"]);
    // Then
    expect(result.status).toBe(0);
    expect((await stat(driver.logRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(resolve(driver.logRoot, "d.log"))).mode & 0o777).toBe(0o600);
    expect(await readFile(resolve(driver.logRoot, "d.log"), "utf8")).toBe("output-d\n");
    expect(result.stdout).toContain(`logs=${driver.logRoot}`);
  });

  it("runs the complete graph by default", async () => {
    // Given no phase selection
    // When
    const result = runDriver(driver);
    // Then
    expect(result.status).toBe(0);
    expect(await executed(driver)).toEqual(["a", "b", "c", "d", "lifecycle"]);
    expect(result.stdout).toContain("self-project-phase-summary passed=5 failed=0 skipped=0");
  });

  it("exposes selection through the actual self-Project gate before setup", () => {
    // Given the production smoke entrypoint
    // When
    const listed = spawnSync("/usr/bin/bash", [smoke, "--list-phases"], { encoding: "utf8" });
    const rejected = spawnSync("/usr/bin/bash", [smoke, "--phase", "unknown"], { encoding: "utf8" });
    // Then
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim().split("\n").map((line) => line.split("\t")[0])).toEqual([
      "workspace", "ssh", "agent", "publication", "retained-volume"
    ]);
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain("unknown self-Project phase: unknown");
  });

  it("replays retained-volume alone through the reproducible driver", async () => {
    // Given the durable phase driver
    // When
    const result = runBehaviorDriver(driver, ["--phase", "retained-volume"]);
    // Then
    expect(result.status).toBe(0);
    expect(await executed(driver)).toEqual(["retained-volume"]);
    expect(result.stdout).toMatch(/PASS\s+retained-volume\s+duration=/);
  });

  it("propagates a selected failure barrier through the reproducible driver", async () => {
    // Given a selected workspace failure before retained-volume
    // When
    const result = runBehaviorDriver(
      driver,
      ["--phase", "workspace", "--phase", "retained-volume"],
      "workspace"
    );
    // Then
    expect(result.status).toBe(1);
    expect(await executed(driver)).toEqual(["workspace"]);
    expect(result.stdout).toMatch(/FAIL\s+workspace\s+duration=/);
    expect(result.stdout).toMatch(/SKIP\s+retained-volume\s+dependency=workspace/);
    expect(result.stdout).not.toContain("phase-driver-errexit-broken");
  });

  it("runs full default coverage through the reproducible driver", async () => {
    // Given no phase selector
    // When
    const result = runBehaviorDriver(driver);
    // Then
    expect(result.status).toBe(0);
    expect(await executed(driver)).toEqual([
      "workspace", "ssh", "agent", "publication", "retained-volume"
    ]);
    expect(result.stdout).toContain("self-project-phase-summary passed=5 failed=0 skipped=0");
  });

  it("gives retained-volume minimal SSH setup and cleanup a fresh workspace identity", async () => {
    // Given the production phase and cleanup modules
    // When
    const [entrypoint, fixture, ssh, lifecycle] = await Promise.all(
      [smoke, sshFixture, sshChecks, finalPhases].map(async (path) => readFile(path, "utf8"))
    );
    const cleanup = entrypoint.slice(
      entrypoint.indexOf("cleanup_managed_resources()"),
      entrypoint.indexOf('if [[ -d "$state_root" ]]')
    );
    // Then
    expect(fixture).toContain("prepare_self_ssh_access()");
    expect(ssh).toContain("prepare_self_ssh_access");
    expect(lifecycle).toMatch(/if \[\[ ! -f "\$ssh_host_fingerprint_file" \]\]; then\s+prepare_self_ssh_access/);
    expect(cleanup.indexOf('workspace_json="$(dim workspace show')).toBeLessThan(
      cleanup.indexOf('dim workspace discard "$workspace_name" --yes')
    );
    expect(cleanup).toContain('workspace_volume_name="$(jq -er .dockerVolumeName');
  });

  it("checks retained tooling inside the isolated retained-volume phase", async () => {
    // Given the production retained-volume phase
    // When
    const [agentChecks, lifecycle] = await Promise.all([
      readFile(resolve(import.meta.dirname, "../scripts/lib/container-self-project-agent-checks.bash"), "utf8"),
      readFile(finalPhases, "utf8")
    ]);
    const reusableStateProbe = agentChecks.indexOf("workspace_user_setup_state()");
    const reusableSetup = agentChecks.indexOf("prepare_workspace_user_setup()");
    const agentPhase = agentChecks.indexOf("self_project_agent_checks()");
    const retainedSetup = lifecycle.indexOf("prepare_workspace_user_setup");
    const stateBefore = lifecycle.indexOf('retained_setup_state_before="$(workspace_user_setup_state)"');
    const discard = lifecycle.indexOf('dim workspace discard "$workspace_name" --keep-volume');
    const stateAfter = lifecycle.indexOf('test "$(workspace_user_setup_state)" = "$retained_setup_state_before"');
    // Then
    expect(reusableStateProbe).toBeGreaterThanOrEqual(0);
    expect(reusableStateProbe).toBeLessThan(agentPhase);
    expect(reusableSetup).toBeGreaterThanOrEqual(0);
    expect(reusableSetup).toBeLessThan(agentPhase);
    expect(retainedSetup).toBeGreaterThan(0);
    expect(retainedSetup).toBeLessThan(stateBefore);
    expect(stateBefore).toBeGreaterThan(0);
    expect(stateBefore).toBeLessThan(discard);
    expect(stateAfter).toBeGreaterThan(discard);
  });
});
