import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { QEMU_CI_SHARED_WORKER } from "../../../../core/packages/core/src/qemuCiRunnerSharedWorkerAsset.js";

describe("shared QEMU worker failure rate", () => {
  it("backs off after an unsuccessful supervisor before making a fresh claim", () => {
    // Given / When
    const result = spawnSync("python3", ["-c", `
import json, os, secrets, subprocess, time, urllib.error, urllib.request
events = []
class Shutdown:
    stopped = False
    def is_set(self):
        return self.stopped
    def wait(self, delay):
        events.append(["wait", delay])
        self.stopped = True
        return True
shutdown = Shutdown()
shared_scheduler_ready = type("Ready", (), {"set": lambda self: None})()
scheduler_project_id = "project"
scheduler_host_id = "host"
capacity = "capacity"
dispatch_labels = {"dim-qemu"}
heartbeat_seconds = 1
class FailedProcess:
    returncode = 1
    args = ["supervise"]
    def poll(self):
        return self.returncode
def popen(*_args, **_kwargs):
    events.append(["spawn"])
    return FailedProcess()
subprocess.Popen = popen
def terminate_supervisor(_process):
    events.append(["reap"])
${QEMU_CI_SHARED_WORKER}
def scheduler_claim(_payload):
    events.append(["claim"])
    return {"jobId": 1, "claimId": "claim", "leaseSeconds": 60}
def scheduler_release(_claim_id, _payload):
    events.append(["release"])
def scheduler_renew(_claim_id, _payload):
    raise AssertionError("unexpected renewal")
shared_worker()
print(json.dumps(events))
`], { encoding: "utf8" });

    // Then
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "")).toEqual([
      ["claim"], ["spawn"], ["reap"], ["release"], ["wait", 2]
    ]);
  });
});
