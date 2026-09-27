import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const verificationRoot = resolve(import.meta.dirname, "..");
const fixturePath = resolve(verificationRoot, "scripts/real-shared-qemu-jobs-smoke.bash");
const assetDriverPath = resolve(verificationRoot, "scripts/real-shared-qemu-assets.mjs");
const fixtureLibraryPath = resolve(verificationRoot, "scripts/lib/real-shared-qemu-jobs.bash");
const recipesPath = resolve(verificationRoot, "verify.just");

describe("real shared QEMU jobs fixture policy", () => {
  it("summarizes two distinct completed jobs without changing the input context", async () => {
    // Given
    const fixture = await readFile(fixturePath, "utf8");
    const program = fixture.match(/jq -s --argjson jobVmMiB "\$job_memory_mb" \\\n\s*'([^']*)'/)?.[1];
    if (program === undefined) throw new Error("summary program is missing");
    const results = [{ jobId: 1, runnerName: "host-a" }, { jobId: 2, runnerName: "host-b" }];

    // When
    const summary = spawnSync("jq", ["-s", "--argjson", "jobVmMiB", "768", program], {
      encoding: "utf8", input: results.map((result) => JSON.stringify(result)).join("\n")
    });

    // Then
    expect(summary.status, summary.stderr).toBe(0);
    expect(JSON.parse(summary.stdout)).toMatchObject({ results, distinctRunnerNames: 2, duplicateJobIds: false });
  });

  it("accepts completed jobs only from the expected runner", async () => {
    // Given
    const library = await readFile(fixtureLibraryPath, "utf8");
    const predicate = library.match(/jq -e --arg runner "\$expected_runner" '([^']*)' "\$jobs_file"/)?.[1];
    if (predicate === undefined) throw new Error("completion predicate is missing");
    const job = { status: "completed", conclusion: "success", runner_name: "host-a" };

    // When
    const accepted = spawnSync("jq", ["-e", "--arg", "runner", "host-a", predicate], {
      input: JSON.stringify({ jobs: [job] }), encoding: "utf8"
    });
    const rejected = spawnSync("jq", ["-e", "--arg", "runner", "host-b", predicate], {
      input: JSON.stringify({ jobs: [job] }), encoding: "utf8"
    });

    // Then
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(rejected.status).not.toBe(0);
  });

  it("uses the production image builder and supervisor assets without a fake supervisor", async () => {
    // Given: the real KVM fixture and its packaged-asset driver.
    const [fixture, assetDriver] = await Promise.all([
      readFile(fixturePath, "utf8"),
      readFile(assetDriverPath, "utf8")
    ]);

    // When / Then: the fixture consumes the production builder output and never writes a replacement supervisor.
    expect(assetDriver).toContain("prepareQemuCiRunnerSupervisorImage");
    expect(assetDriver).toContain("qemuCiRunnerProductionImageKeys");
    expect(assetDriver).toContain("QEMU_CI_PROJECT_NOOP_HOOK_SCRIPT");
    expect(fixture).toContain("supervisorImageId");
    expect(fixture).not.toMatch(/cat\s+>[^\n]*supervise/);
    expect(fixture).not.toContain("fake one-job");
  });

  it("isolates two logical hosts and constrains real job VMs to sequential 768 MiB execution", async () => {
    // Given: a fixture intended for an outer guest with a small memory budget.
    const [fixture, fixtureLibrary] = await Promise.all([
      readFile(fixturePath, "utf8"),
      readFile(fixtureLibraryPath, "utf8")
    ]);
    const completeFixture = `${fixture}\n${fixtureLibrary}`;

    // When / Then: host identity, storage, and sequential capacity are explicit machine inputs.
    expect(completeFixture).toContain("DIM_QEMU_SCHEDULER_HOST_ID=$host_id");
    expect(completeFixture).toContain("DIM_QEMU_CI_MEMORY_MB=$job_memory_mb");
    expect(fixture).toMatch(/job_memory_mb="\$\{DIM_REAL_SHARED_QEMU_JOB_MEMORY_MB:-768\}"/);
    expect(completeFixture).toContain('start_worker host-a "$work_dir/assets-host-a.json"');
    expect(completeFixture).toContain('start_worker host-b "$work_dir/assets-host-b.json"');
    expect(fixtureLibrary).toContain('"$prefix-data"');
    expect(fixtureLibrary).toContain('"$prefix-common"');
    expect(fixtureLibrary).toContain('"$prefix-project"');
    expect(fixture.indexOf("stop_worker host-a")).toBeLessThan(fixture.indexOf("queue_workflow host-b"));
  });

  it("retains host A's immutable supervisor image while the shared production tag is rebuilt", async () => {
    // Given: both logical hosts build through the production factory's shared local tag.
    const fixture = await readFile(fixturePath, "utf8");

    // When: host B's build replaces the shared tag before host A starts.
    const firstBuild = fixture.indexOf('"$work_dir/assets-host-a.json"');
    const retentionTag = fixture.indexOf('docker image tag "$supervisor_image_id" "$host_a_supervisor_image"');
    const secondBuild = fixture.indexOf('"$work_dir/assets-host-b.json"');
    const firstLaunch = fixture.indexOf('start_worker host-a "$work_dir/assets-host-a.json"');

    // Then: a fixture-owned tag retains host A's immutable ID until cleanup.
    expect(firstBuild).toBeGreaterThan(-1);
    expect(retentionTag).toBeGreaterThan(firstBuild);
    expect(secondBuild).toBeGreaterThan(retentionTag);
    expect(firstLaunch).toBeGreaterThan(secondBuild);
    expect(fixture).toContain('host_a_supervisor_image="$resource_prefix-host-a-supervisor-image"');
    expect(fixture).toContain('docker image rm --force "$host_a_supervisor_image"');
  });

  it("observes coordinator job success and distinct runner names before bounded cleanup", async () => {
    // Given: real Gitea workflow jobs coordinated through the shared scheduler.
    const [fixture, fixtureLibrary] = await Promise.all([
      readFile(fixturePath, "utf8"),
      readFile(fixtureLibraryPath, "utf8")
    ]);
    const completeFixture = `${fixture}\n${fixtureLibrary}`;

    // When / Then: completion evidence comes from Gitea's jobs API and is deadline-bounded.
    expect(completeFixture).toContain("/actions/runs/$run_id/jobs");
    expect(completeFixture).toContain("runner_name");
    expect(completeFixture).toContain('conclusion == "success"');
    expect(fixtureLibrary).toContain("shell: sh");
    expect(fixtureLibrary).toContain('docker container stop --time 30 "$container"');
    expect(fixture).toContain("timeout_at=$((SECONDS + fixture_timeout_seconds))");
    expect(fixture).toContain("cleanup_resources");
    expect(fixture).toContain("summary.json");
  });

  it("aborts after three supervisor failures reported by the host-owned worker", async () => {
    // Given: an owned worker with three deterministic supervisor failures and an unavailable coordinator API.
    const root = await mkdtemp(join(tmpdir(), "dim-real-shared-waiter-"));
    const evidenceDir = join(root, "evidence");
    const workDir = join(root, "work");

    try {
      // When: the workflow waiter inspects its worker before polling the coordinator.
      const result = spawnSync("bash", ["-c", `
set -Eeuo pipefail
source "$1"
resource_prefix=fixture-owned
evidence_dir="$2"
work_dir="$3"
organization=fixture
timeout_at=$((SECONDS + 3600))
mkdir -p "$evidence_dir" "$work_dir"
docker() {
  [[ "$1" == logs && "$2" == fixture-owned-host-a-worker ]]
  printf '%s\n' \
    'qemu-ci-scheduler: shared supervisor failed: first private detail' \
    'qemu-ci-scheduler: shared supervisor failed: second private detail' \
    'qemu-ci-scheduler: shared supervisor failed: third private detail'
}
gitea_api() { return 91; }
wait_for_workflow host-a deadbeef expected-marker
`, "bash", fixtureLibraryPath, evidenceDir, workDir], { encoding: "utf8" });

      // Then: it fails immediately with sanitized metadata and never reaches the API fallback.
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("aborted after 3 shared supervisor failures");
      expect(result.stderr).not.toContain("private detail");
      await expect(readFile(join(evidenceDir, "supervisor-failures-host-a.json"), "utf8"))
        .resolves.toBe('{"schemaVersion":1,"host":"host-a","workerContainer":"fixture-owned-host-a-worker","runnerName":"fixture-owned-host-a-qemu","sharedSupervisorFailures":3}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes successful completion evidence even when standard input is empty", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-real-shared-result-"));
    try {
      // When
      const result = spawnSync("bash", ["-c", `
set -Eeuo pipefail
source "$1"
resource_prefix=fixture-owned
evidence_dir="$2"
work_dir="$2"
organization=fixture
timeout_at=$((SECONDS + 5))
docker() { [[ "$1" == logs && "$2" == fixture-owned-host-a-worker ]]; }
gitea_api() {
  local payload
  case "$2" in
    */actions/runners) payload='{"runners":[{"name":"fixture-owned-host-a-qemu"}]}' ;;
    */actions/runs\\?limit=20) payload='{"workflow_runs":[{"id":41,"head_sha":"deadbeef","status":"completed","conclusion":"success"}]}' ;;
    */actions/runs/41/jobs) payload='{"jobs":[{"id":42,"status":"completed","conclusion":"success","runner_name":"fixture-owned-host-a-qemu"}]}' ;;
    */actions/jobs/42/logs) payload='expected-marker' ;;
    *) return 91 ;;
  esac
  printf '%s\\n' "$payload" >"$GITEA_API_OUTPUT"
}
wait_for_workflow host-a deadbeef expected-marker
`, "bash", fixtureLibraryPath, root], { encoding: "utf8", input: "" });

      // Then
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(await readFile(join(root, "result-host-a.json"), "utf8"))).toEqual({
        host: "host-a", runId: 41, jobId: 42, runnerName: "fixture-owned-host-a-qemu",
        marker: "expected-marker", conclusion: "success"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues after one supervisor failure and surfaces coordinator errors", async () => {
    // Given: one transient owned-worker failure followed by a coordinator polling error.
    const root = await mkdtemp(join(tmpdir(), "dim-real-shared-transient-"));
    const evidenceDir = join(root, "evidence");
    const workDir = join(root, "work");

    try {
      // When: the workflow waiter checks both sources of truth.
      const result = spawnSync("bash", ["-c", `
set -Eeuo pipefail
source "$1"
resource_prefix=fixture-owned
evidence_dir="$2"
work_dir="$3"
organization=fixture
timeout_at=$((SECONDS + 3600))
mkdir -p "$evidence_dir" "$work_dir"
docker() {
  [[ "$1" == logs && "$2" == fixture-owned-host-a-worker ]]
  printf '%s\n' 'qemu-ci-scheduler: shared supervisor failed: transient private detail'
}
gitea_api() { return 91; }
wait_for_workflow host-a deadbeef expected-marker
`, "bash", fixtureLibraryPath, evidenceDir, workDir], { encoding: "utf8" });

      // Then: one failure is not treated as completion or a terminal threshold, and the API error remains visible.
      expect(result.status).toBe(91);
      expect(result.stderr).not.toContain("aborted after");
      await expect(readFile(join(evidenceDir, "supervisor-failures-host-a.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes an explicit capability-gated verification recipe", async () => {
    // Given: the repository verification recipes.
    const recipes = await readFile(recipesPath, "utf8");

    // When / Then: the real lane is separate from the fake packaged scheduler smoke.
    expect(recipes).toMatch(/^real-shared-qemu-jobs-kvm:/m);
    expect(recipes).toContain("real-shared-qemu-jobs-smoke.bash");
    expect(recipes).toContain("requires x86-64");
    expect(recipes).toContain("requires an accessible character /dev/kvm");
  });
});
