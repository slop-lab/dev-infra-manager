import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("example controller cleanup safety", () => {
  it.each([
    "single-repository-example-smoke.bash",
    "two-repository-example-smoke.bash",
    "multi-repository-example-smoke.bash"
  ])("reports scratch removal failure as uncertain cleanup in %s", async (name) => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "dim-example-removal-failure-"));
    fixtureRoots.push(root);
    const smoke = await readFile(resolve(workspaceRoot, "verification/scripts", name), "utf8");
    const start = smoke.indexOf("cleanup() {");
    const end = smoke.indexOf("\ntrap cleanup EXIT", start);
    const cleanup = smoke.slice(start, end);
    const script = `set -uo pipefail
work_dir="$1"
state_root="$work_dir/state"
workspace_name=fixture-workspace
project_name=fixture-project
controller_evidence="$work_dir/evidence.log"
dim_capture_example_controller_failure() { :; }
dim_stop_local_npm_registry() { :; }
dim_stop_example_controller() { :; }
docker() { return 1; }
rm() { return 19; }
${cleanup}
cleanup
`;

    // When
    const result = spawnSync("/usr/bin/bash", ["-c", script, "bash", root], { encoding: "utf8" });

    // Then
    expect(result.status, result.stderr).toBe(125);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it("preserves foreign CI boundary roots when ownership identities were never captured", async () => {
    // Given: foreign state and source roots that make the real boundary precondition fail.
    const root = await mkdtemp(resolve(tmpdir(), "dim-ci-unclaimed-roots-"));
    fixtureRoots.push(root);
    const stateRoot = resolve(root, "foreign-state");
    const sourceRoot = resolve(root, "foreign-source");
    const stateSentinel = resolve(stateRoot, "sentinel");
    const sourceSentinel = resolve(sourceRoot, "sentinel");
    const sudoLog = resolve(root, "sudo.log");
    await Promise.all([mkdir(stateRoot), mkdir(sourceRoot)]);
    await Promise.all([writeFile(stateSentinel, "state-owned-elsewhere\n"), writeFile(sourceSentinel, "source-owned-elsewhere\n")]);
    const smoke = await readFile(
      resolve(workspaceRoot, "verification/scripts/kvm-guest-verification-smoke.bash"),
      "utf8"
    );
    const boundaryStart = smoke.indexOf("ci_runner_boundary() (");
    const boundaryEnd = smoke.indexOf("\n)\n\nnon_root_ci()", boundaryStart) + 2;
    expect(boundaryStart).toBeGreaterThan(-1);
    expect(boundaryEnd).toBeGreaterThan(boundaryStart);
    const boundary = smoke.slice(boundaryStart, boundaryEnd)
      .replace(/local state_root=.*/, 'local state_root="$DIM_TEST_STATE_ROOT"')
      .replace(/local source_root=.*/, 'local source_root="$DIM_TEST_SOURCE_ROOT"');
    const script = `set -uo pipefail
repo_root="$1"
export DIM_TEST_STATE_ROOT="$2"
export DIM_TEST_SOURCE_ROOT="$3"
export DIM_VERIFICATION_LOG_ROOT="$1/logs"
sudo_log="$4"
mkdir -p "$DIM_VERIFICATION_LOG_ROOT"
dim_capture_example_controller_failure() { :; }
dim_stop_example_controller() { :; }
sudo() { printf '%s\\n' "$*" >>"$sudo_log"; "$@"; }
${boundary}
ci_runner_boundary
`;

    // When: the boundary exits at its no-preexisting-roots precondition.
    const result = spawnSync("/usr/bin/bash", ["-c", script, "bash", root, stateRoot, sourceRoot, sudoLog], {
      encoding: "utf8",
      env: process.env
    });

    // Then: cleanup is uncertain, both foreign sentinels survive, and sudo removal was never attempted.
    await expect(readFile(stateSentinel, "utf8")).resolves.toBe("state-owned-elsewhere\n");
    await expect(readFile(sourceSentinel, "utf8")).resolves.toBe("source-owned-elsewhere\n");
    await expect(readFile(sudoLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.status, result.stderr).toBe(125);
  });

  it("retains CI runner recovery state when runner deletion fails but controller stop succeeds", async () => {
    // Given: the checked-in cleanup function and owned state whose runner deletion fails.
    const root = await mkdtemp(resolve(tmpdir(), "dim-ci-cleanup-uncertain-"));
    fixtureRoots.push(root);
    const work = resolve(root, "work");
    const smoke = await readFile(
      resolve(workspaceRoot, "verification/scripts/ci-runner-example-smoke.bash"),
      "utf8"
    );
    const cleanupStart = smoke.indexOf("cleanup() {");
    const cleanupEnd = smoke.indexOf("\ntrap cleanup EXIT", cleanupStart);
    expect(cleanupStart).toBeGreaterThan(-1);
    expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    const cleanup = smoke.slice(cleanupStart, cleanupEnd);
    const script = `set -uo pipefail
work_dir="$1"
state_root="$work_dir/state"
project_name=fixture-project
runner_name=primary
organization=fixture-organization
controller_evidence="$work_dir/evidence.log"
stopped="$2"
mkdir -p "$state_root/ci-runners/$project_name"
printf '%s\\n' recovery >"$state_root/ci-runners/$project_name/$runner_name.json"
dim_capture_example_controller_failure() { :; }
dim() { return 19; }
docker() { return 1; }
gitea_api() { :; }
dim_stop_local_npm_registry() { :; }
dim_stop_example_controller() { printf '%s\\n' stopped >"$stopped"; }
${cleanup}
cleanup
`;
    const stopped = resolve(root, "controller.stopped");

    // When: cleanup runs after a successful body but cannot delete the runner.
    const result = spawnSync("/usr/bin/bash", ["-c", script, "bash", work, stopped], {
      encoding: "utf8",
      env: process.env
    });

    // Then: stop is still attempted, status is uncertain, and all recovery state remains.
    expect(result.status, result.stderr).toBe(125);
    await expect(readFile(stopped, "utf8")).resolves.toBe("stopped\n");
    await expect(readFile(resolve(work, "state/ci-runners/fixture-project/primary.json"), "utf8"))
      .resolves.toBe("recovery\n");
  });

  it.each(["file", "symlink"] as const)(
    "rejects an existing evidence %s without mutating the foreign file",
    async (kind) => {
      // Given: a controller log and an evidence path already owned by another file.
      const root = await mkdtemp(resolve(tmpdir(), `dim-controller-evidence-${kind}-`));
      fixtureRoots.push(root);
      const evidence = resolve(root, "evidence.log");
      const foreign = kind === "file" ? evidence : resolve(root, "foreign.log");
      await writeFile(foreign, "foreign-content\n");
      await chmod(foreign, kind === "file" ? 0o666 : 0o640);
      if (kind === "symlink") await symlink(foreign, evidence);
      const helper = resolve(workspaceRoot, "verification/scripts/lib/example-dim-install.bash");
      const script = `set -uo pipefail
source "$1"
export DIM_STATE_ROOT="$2/state"
dim_prepare_example_controller_runtime
mkdir -p "$(dirname "$DIM_EXAMPLE_CONTROLLER_LOG")"
printf '%s\\n' '{"adminPassword":"foreign-secret"}' >"$DIM_EXAMPLE_CONTROLLER_LOG"
dim_capture_example_controller_failure "$3" "fixture controller"
status=$?
dim_stop_example_controller
exit "$status"
`;

      // When: evidence capture targets that existing path.
      const result = spawnSync("/usr/bin/bash", ["-c", script, "bash", helper, root, evidence], {
        encoding: "utf8",
        env: process.env
      });

      // Then: capture fails without truncating, chmodding, or following the foreign path.
      expect(result.status).not.toBe(0);
      await expect(readFile(foreign, "utf8")).resolves.toBe("foreign-content\n");
      expect((await stat(foreign)).mode & 0o777).toBe(kind === "file" ? 0o666 : 0o640);
      if (kind === "symlink") expect((await lstat(evidence)).isSymbolicLink()).toBe(true);
    }
  );
});
