import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  conditionWithin,
  pathExists,
  recordedLines,
  recordedPids,
  schedulerDirectory,
  schedulerHealthStatus,
  schedulerState,
  sendWorkflowJob,
  signalScheduler,
  startScheduler,
  stopRecordedProcesses,
  stopScheduler,
  waitFor
} from "./qemuCiRunnerWebhookHarness.js";

export function registerWebhookFailureScenarios(): void {
  it.each(["missing", "replaced"] as const)("keeps an active supervisor running and stops renewing when its trigger claim is %s", async (ownershipChange) => {
    const directory = await schedulerDirectory(`renewal-${ownershipChange}`);
    const startsPath = join(directory, "supervisor-starts");
    const runnerPath = join(directory, ".runner");
    const terminationPath = join(directory, "supervisor-terminated");
    const ownershipChangedPath = join(directory, "ownership-changed");
    const postLossHeartbeatsPath = join(directory, "post-loss-heartbeats");
    const renewAttemptsPath = join(directory, "renew-attempts");
    const lostClaimLogsPath = join(directory, "lost-claim-logs");
    const releaseObservedPath = join(directory, "claim-release-observed");
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
printf '%s\n' "$$" >> ${JSON.stringify(startsPath)}
: > ${JSON.stringify(runnerPath)}
trap ': > ${JSON.stringify(terminationPath)}; exit 0' TERM
python3 -c 'import signal; signal.pause()' &
wait "$!"
`);
    const replacement = ownershipChange === "replaced"
      ? `state["claims"][420] = {"owner": "successor-capacity", "updated": time.time()}`
      : `state["claims"].pop(420, None)`;
    const scheduler = await startScheduler(directory, {
      capacity: "capacity-lease-owner",
      pythonSetup: `
real_locked_update = locked_update
real_shutdown_wait = shutdown.wait
import builtins
real_print = builtins.print
ownership_change_pending = True
renewal_stopped = False
def injected_locked_update(update):
    global ownership_change_pending, renewal_stopped
    if update.__name__ == "renew":
        with open(${JSON.stringify(renewAttemptsPath)}, "a", encoding="utf-8") as attempts:
            attempts.write("renew\\n")
        if ownership_change_pending:
            ownership_change_pending = False
            def change_ownership(state):
                ${replacement}
            real_locked_update(change_ownership)
            with open(${JSON.stringify(ownershipChangedPath)}, "w", encoding="utf-8"):
                pass
        result = real_locked_update(update)
        if not result:
            renewal_stopped = True
        return result
    result = real_locked_update(update)
    if update.__name__ == "release_claim":
        with open(${JSON.stringify(releaseObservedPath)}, "w", encoding="utf-8"):
            pass
    return result
def observed_shutdown_wait(timeout=None):
    result = real_shutdown_wait(timeout)
    if timeout == heartbeat_seconds and renewal_stopped:
        with open(${JSON.stringify(postLossHeartbeatsPath)}, "a", encoding="utf-8") as heartbeats:
            heartbeats.write("heartbeat\\n")
    return result
def observed_print(*values, **kwargs):
    if values and str(values[0]).startswith("qemu-ci-scheduler: capacity capacity-lease-owner lost trigger claim ownership"):
        with open(${JSON.stringify(lostClaimLogsPath)}, "a", encoding="utf-8") as logs:
            logs.write("lost\\n")
    return real_print(*values, **kwargs)
locked_update = injected_locked_update
shutdown.wait = observed_shutdown_wait
builtins.print = observed_print`
    });

    try {
      await sendWorkflowJob(scheduler.port, 420, "queued");
      await waitFor(async () => pathExists(runnerPath));
      await waitFor(async () => pathExists(ownershipChangedPath));

      // When
      await waitFor(async () => (await recordedLines(postLossHeartbeatsPath)).length >= 2);

      // Then
      expect.soft(await recordedPids(startsPath)).toHaveLength(1);
      const supervisorPid = (await recordedPids(startsPath))[0];
      expect.soft(supervisorPid === undefined ? false : await pathExists(`/proc/${supervisorPid}`)).toBe(true);
      expect.soft(await pathExists(terminationPath)).toBe(false);
      expect.soft(await recordedLines(renewAttemptsPath)).toHaveLength(1);
      expect.soft(await recordedLines(lostClaimLogsPath)).toHaveLength(1);
      await expect(signalScheduler(scheduler, "SIGTERM")).resolves.toBe(true);
      expect.soft(await pathExists(releaseObservedPath)).toBe(true);
      const claim = (await schedulerState(scheduler.statePath)).claims["420"];
      if (ownershipChange === "replaced") {
        expect.soft(claim).toMatchObject({ owner: "successor-capacity" });
      } else {
        expect.soft(claim).toBeUndefined();
      }
    } finally {
      await stopScheduler(scheduler);
      await stopRecordedProcesses(startsPath);
    }
  }, 10_000);

  it("terminates and reaps a live supervisor before releasing a claim after heartbeat state failure", async () => {
    // Given
    const directory = await schedulerDirectory("heartbeat-state-failure");
    const startsPath = join(directory, "supervisor-starts");
    const terminationsPath = join(directory, "supervisor-terminations");
    const overlappingStartPath = join(directory, "overlapping-supervisor-start");
    const prematureReleasePath = join(directory, "premature-claim-release");
    const renewFailurePath = join(directory, "renew-failure");
    const releasePath = join(directory, "release-supervisors");
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
if [[ -s ${JSON.stringify(startsPath)} ]]; then
  IFS= read -r first_pid < ${JSON.stringify(startsPath)}
  if kill -0 "$first_pid" 2>/dev/null; then
    : > ${JSON.stringify(overlappingStartPath)}
  fi
fi
printf '%s\\n' "$$" >> ${JSON.stringify(startsPath)}
trap 'printf "%s\\n" "$$" >> ${JSON.stringify(terminationsPath)}; exit 0' TERM
while [[ ! -f ${JSON.stringify(releasePath)} ]]; do sleep 0.02; done
`);
    const scheduler = await startScheduler(directory, {
      capacity: "capacity-heartbeat-failure",
      pythonSetup: `
real_locked_update = locked_update
renew_failure_pending = True
def injected_locked_update(update):
    global renew_failure_pending
    if update.__name__ == "renew" and renew_failure_pending:
        renew_failure_pending = False
        with open(${JSON.stringify(renewFailurePath)}, "w", encoding="utf-8") as marker:
            marker.write("failed")
        raise OSError("injected renew state failure")
    if update.__name__ == "release_claim":
        with open(${JSON.stringify(startsPath)}, encoding="utf-8") as starts:
            first_pid = starts.readline().strip()
        if first_pid and os.path.exists("/proc/" + first_pid):
            with open(${JSON.stringify(prematureReleasePath)}, "w", encoding="utf-8") as marker:
                marker.write(first_pid)
    return real_locked_update(update)
locked_update = injected_locked_update`
    });

    try {
      await sendWorkflowJob(scheduler.port, 413, "queued");
      await waitFor(async () => pathExists(renewFailurePath));

      // When
      const recovered = await conditionWithin(async () => (await recordedPids(startsPath)).length === 2);

      // Then
      const startedPids = await recordedPids(startsPath);
      const terminatedPids = await recordedPids(terminationsPath);
      const firstPid = startedPids[0];
      expect.soft(await pathExists(prematureReleasePath)).toBe(false);
      expect.soft(await pathExists(overlappingStartPath)).toBe(false);
      expect.soft(firstPid === undefined ? false : terminatedPids.includes(firstPid)).toBe(true);
      expect.soft(firstPid === undefined ? false : !(await pathExists(`/proc/${firstPid}`))).toBe(true);
      expect.soft(recovered).toBe(true);
      expect.soft(startedPids).toHaveLength(2);
      expect.soft(await schedulerState(scheduler.statePath)).toMatchObject({
        queued: [413], claims: { "413": { owner: "capacity-heartbeat-failure" } }
      });
      expect.soft(await schedulerHealthStatus(scheduler.port)).toBe(200);
    } finally {
      await writeFile(releasePath, "release");
      await stopScheduler(scheduler);
      await stopRecordedProcesses(startsPath);
    }
  }, 15_000);
}
