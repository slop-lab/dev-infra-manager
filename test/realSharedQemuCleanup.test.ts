import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../scripts/real-shared-qemu-jobs-smoke.bash");

describe("real shared QEMU fixture cleanup", () => {
  it("restores a preexisting supervisor tag and removes both fixture builds when host B preparation fails", async () => {
    // Given: host A is recorded and retained while host B has replaced the production tag before failing.
    const root = await mkdtemp(join(tmpdir(), "dim-real-shared-cleanup-"));
    const callLog = join(root, "docker-calls.log");
    const fixture = await readFile(fixturePath, "utf8");

    try {
      // When: the EXIT cleanup runs with a preexisting production image and no host B asset JSON.
      const result = spawnSync("bash", ["-c", `
set -u
source <(sed -n '/^cleanup_resources() {$/,/^}$/p' "$1")
work_dir="$2/work"
evidence_dir="$2/evidence"
call_log="$3"
mkdir -p "$work_dir" "$evidence_dir"
active_workers=()
host_volumes=()
scheduler_container=fixture-scheduler
gitea_container=fixture-gitea
cache_container=fixture-cache
init_container=fixture-init
scheduler_volume=fixture-scheduler-state
cache_volume=fixture-cache-state
network=fixture-net
scheduler_image=fixture-scheduler-image
host_a_supervisor_image=fixture-host-a-supervisor-image
prior_supervisor_image=sha256:${"1".repeat(64)}
supervisor_image_ids=(sha256:${"a".repeat(64)})
docker() {
  printf '%s\n' "$*" >>"$call_log"
  if [[ "$1" == image && "$2" == inspect ]]; then
    printf 'sha256:${"b".repeat(64)}\n'
  fi
}
set +e
(exit 17)
cleanup_resources
`, "bash", fixturePath, root, callLog], { encoding: "utf8" });

      // Then: current-tag capture precedes restoration, and only fixture-owned IDs are removed without force.
      expect(result.status).toBe(17);
      const calls = (await readFile(callLog, "utf8")).trim().split("\n");
      const inspect = calls.indexOf("image inspect dim-qemu-ci-supervisor:0.9 --format {{.Id}}");
      const restore = calls.indexOf(`image tag sha256:${"1".repeat(64)} dim-qemu-ci-supervisor:0.9`);
      const removeA = calls.indexOf(`image rm sha256:${"a".repeat(64)}`);
      const removeB = calls.indexOf(`image rm sha256:${"b".repeat(64)}`);
      expect(inspect).toBeGreaterThan(-1);
      expect(restore).toBeGreaterThan(inspect);
      expect(removeA).toBeGreaterThan(restore);
      expect(removeB).toBeGreaterThan(restore);
      expect(calls).not.toContain(`image rm sha256:${"1".repeat(64)}`);
      expect(calls).not.toContain(`image rm --force sha256:${"a".repeat(64)}`);
      expect(calls).not.toContain(`image rm --force sha256:${"b".repeat(64)}`);

      const firstId = fixture.indexOf('supervisor_image_id="$(jq -er .supervisorImageId "$work_dir/assets-host-a.json")"');
      const firstRecord = fixture.indexOf('supervisor_image_ids=("$supervisor_image_id")');
      const secondBuild = fixture.indexOf('"$work_dir/assets-host-b.json"');
      expect(firstRecord).toBeGreaterThan(firstId);
      expect(secondBuild).toBeGreaterThan(firstRecord);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
