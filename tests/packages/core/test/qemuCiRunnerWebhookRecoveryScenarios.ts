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
  startScheduler,
  stopRecordedProcesses,
  stopScheduler,
  waitFor
} from "./qemuCiRunnerWebhookHarness.js";

export function registerWebhookRecoveryScenarios(): void {
  it("continues claiming queued work after a one-shot claim state failure", async () => {
    // Given
    const directory = await schedulerDirectory("claim-state-failure");
    const startsPath = join(directory, "supervisor-starts");
    const terminationsPath = join(directory, "supervisor-terminations");
    const claimFailurePath = join(directory, "claim-failure");
    const releasePath = join(directory, "release-supervisor");
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$$" >> ${JSON.stringify(startsPath)}
trap 'printf "%s\\n" "$$" >> ${JSON.stringify(terminationsPath)}; exit 0' TERM
while [[ ! -f ${JSON.stringify(releasePath)} ]]; do sleep 0.02; done
`);
    const scheduler = await startScheduler(directory, {
      capacity: "capacity-claim-failure",
      pythonSetup: `
real_locked_update = locked_update
claim_failure_pending = True
def injected_locked_update(update):
    global claim_failure_pending
    if update.__name__ == "claim_one" and claim_failure_pending:
        claim_failure_pending = False
        with open(${JSON.stringify(claimFailurePath)}, "w", encoding="utf-8") as marker:
            marker.write("failed")
        raise OSError("injected claim state failure")
    return real_locked_update(update)
locked_update = injected_locked_update`
    });

    try {
      await waitFor(async () => pathExists(claimFailurePath));

      // When
      await sendWorkflowJob(scheduler.port, 414, "queued");
      const workerRecovered = await conditionWithin(async () => (await recordedPids(startsPath)).length === 1);

      // Then
      expect.soft(workerRecovered).toBe(true);
      expect.soft(await recordedPids(startsPath)).toHaveLength(1);
      expect.soft(await schedulerState(scheduler.statePath)).toMatchObject({
        queued: [414], claims: { "414": { owner: "capacity-claim-failure" } }
      });
      expect.soft(await schedulerHealthStatus(scheduler.port)).toBe(200);
    } finally {
      await writeFile(releasePath, "release");
      await stopScheduler(scheduler);
      await stopRecordedProcesses(startsPath);
    }
  }, 15_000);

  it("releases and reclaims queued work after a one-shot supervisor launch failure", async () => {
    // Given
    const directory = await schedulerDirectory("supervisor-launch-failure");
    const startsPath = join(directory, "supervisor-starts");
    const releaseAttemptsPath = join(directory, "release-attempts");
    const launchFailurePath = join(directory, "launch-failure");
    const releasePath = join(directory, "release-supervisor");
    const supervisorPath = join(directory, "supervise.bash");
    await writeFile(supervisorPath, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$$" >> ${JSON.stringify(startsPath)}
while [[ ! -f ${JSON.stringify(releasePath)} ]]; do sleep 0.02; done
`);
    const scheduler = await startScheduler(directory, {
      capacity: "capacity-launch-failure",
      pythonSetup: `
real_popen = subprocess.Popen
real_locked_update = locked_update
launch_failure_pending = True
def injected_popen(command, *args, **kwargs):
    global launch_failure_pending
    if command == ["bash", ${JSON.stringify(supervisorPath)}] and launch_failure_pending:
        launch_failure_pending = False
        with open(${JSON.stringify(launchFailurePath)}, "w", encoding="utf-8") as marker:
            marker.write("failed")
        raise OSError("injected supervisor launch failure")
    return real_popen(command, *args, **kwargs)
def observed_locked_update(update):
    if update.__name__ == "release_claim":
        with open(${JSON.stringify(releaseAttemptsPath)}, "a", encoding="utf-8") as attempts:
            attempts.write("release\\n")
    return real_locked_update(update)
subprocess.Popen = injected_popen
locked_update = observed_locked_update`
    });

    try {
      await sendWorkflowJob(scheduler.port, 415, "queued");
      await waitFor(async () => pathExists(launchFailurePath));

      // When
      const recovered = await conditionWithin(async () => (await recordedPids(startsPath)).length === 1);

      // Then
      expect.soft(recovered).toBe(true);
      expect.soft(await recordedPids(startsPath)).toHaveLength(1);
      expect.soft(await recordedLines(releaseAttemptsPath)).toHaveLength(1);
      expect.soft(await schedulerState(scheduler.statePath)).toMatchObject({
        queued: [415], claims: { "415": { owner: "capacity-launch-failure" } }
      });
      expect.soft(await schedulerHealthStatus(scheduler.port)).toBe(200);
    } finally {
      await writeFile(releasePath, "release");
      await stopScheduler(scheduler);
      await stopRecordedProcesses(startsPath);
    }
  }, 15_000);
}
