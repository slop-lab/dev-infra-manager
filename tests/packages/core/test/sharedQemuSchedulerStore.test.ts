import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const assets = join(import.meta.dirname, "../../../../core/packages/core/src/shared-qemu-scheduler-assets");

describe("shared QEMU scheduler persistent store bounds", () => {
  it("caps all nonterminal demand including unsolicited running events", () => {
    // Given / When
    const result = runPython(`
import pathlib, tempfile
import store as store_module
from protocol import ProjectId
from store import SchedulerStore, StoreCapacityError
store_module.MAX_NONTERMINAL_JOBS = 2
now = [1000.0]
with tempfile.TemporaryDirectory() as root:
    store = SchedulerStore(pathlib.Path(root) / "state.sqlite3", 60, lambda: now[0])
    project = ProjectId("project")
    store.record_event(project, "in_progress", 1, ("dim-qemu",))
    store.record_event(project, "queued", 2, ("dim-qemu",))
    try:
        store.record_event(project, "in_progress", 3, ("dim-qemu",))
    except StoreCapacityError:
        pass
    else:
        raise AssertionError("nonterminal capacity was not enforced")
    store.record_event(project, "completed", 1, ("dim-qemu",))
    assert store.record_event(project, "in_progress", 3, ("dim-qemu",)) == "recorded"
`);

    // Then
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("caps claim receipts without evicting a live fence and recovers after retention", () => {
    // Given / When
    const result = runPython(`
import pathlib, tempfile
import store as store_module
from protocol import HostId, ProjectId
from store import SchedulerStore, StoreCapacityError
store_module.MAX_CLAIM_REQUESTS = 2
now = [1000.0]
with tempfile.TemporaryDirectory() as root:
    store = SchedulerStore(pathlib.Path(root) / "state.sqlite3", 60, lambda: now[0])
    project, host = ProjectId("project"), HostId("host-a")
    for job_id in (1, 2, 3):
        store.record_event(project, "queued", job_id, ("dim-qemu",))
    first = store.claim(project, host, "capacity", ("dim-qemu",), "request-1")
    assert first is not None and store.release(project, host, first.claim_id)
    second = store.claim(project, host, "capacity", ("dim-qemu",), "request-2")
    assert second is not None
    try:
        store.claim(project, HostId("host-b"), "other", ("dim-qemu",), "request-3")
    except StoreCapacityError:
        pass
    else:
        raise AssertionError("claim receipt capacity was not enforced")
    assert store.renew(project, host, second.claim_id) == "renewed"
    assert store.release(project, host, second.claim_id)
    now[0] += 7 * 24 * 60 * 60 + 1
    assert store.claim(project, host, "capacity", ("dim-qemu",), "request-3") is not None
`);

    // Then
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

function runPython(source: string): ReturnType<typeof spawnSync> {
  return spawnSync("python3", ["-c", source], {
    env: { ...process.env, PYTHONPATH: assets },
    encoding: "utf8"
  });
}
