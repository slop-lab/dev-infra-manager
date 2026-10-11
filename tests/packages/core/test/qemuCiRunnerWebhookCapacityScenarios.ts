import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  pathExists,
  recordedLines,
  schedulerDirectory,
  schedulerState,
  sendWorkflowJob,
  startScheduler,
  stopRecordedProcesses,
  stopScheduler,
  waitFor
} from "./qemuCiRunnerWebhookHarness.js";

export function registerWebhookCapacityScenarios(): void {
  it("lets another capacity claim queued work without dropping the active running claim", async () => {
    // Given
    const directory = await schedulerDirectory("parallel-running-claims");
    const startsPath = join(directory, "supervisor-starts");
    const terminationsPath = join(directory, "supervisor-terminations");
    const releasePath = join(directory, "release-supervisors");
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
printf '%s %s\\n' "$DIM_QEMU_CI_CAPACITY" "$$" >> ${JSON.stringify(startsPath)}
trap 'printf "%s\\n" "$DIM_QEMU_CI_CAPACITY" >> ${JSON.stringify(terminationsPath)}; exit 0' TERM
while [[ ! -f ${JSON.stringify(releasePath)} ]]; do sleep 0.02; done
`);
    const first = await startScheduler(directory, { capacity: "capacity-parallel-1" });
    const second = await startScheduler(directory, { capacity: "capacity-parallel-2" });

    try {
      await sendWorkflowJob(first.port, 422, "queued");
      await waitFor(async () => (await schedulerState(first.statePath)).claims["422"] !== undefined);
      const firstClaim = (await schedulerState(first.statePath)).claims["422"];
      const firstOwner = firstClaim?.owner ?? "";
      expect(firstOwner).not.toBe("");
      await waitFor(async () => (await recordedLines(startsPath)).some((line) => line.startsWith(`${firstOwner} `)));
      const firstStart = (await recordedLines(startsPath)).find((line) => line.startsWith(`${firstOwner} `));
      const firstPid = Number(firstStart?.split(" ")[1] ?? "0");
      await sendWorkflowJob(first.port, 422, "in_progress");

      // When
      await sendWorkflowJob(second.port, 423, "queued");
      await waitFor(async () => {
        const owner = (await schedulerState(first.statePath)).claims["423"]?.owner;
        return owner !== undefined && owner !== firstOwner;
      });

      // Then
      const bothClaimed = await schedulerState(first.statePath);
      expect(bothClaimed.claims["422"]).toMatchObject({ owner: firstOwner });
      expect(bothClaimed.claims["423"]?.owner).not.toBe(firstOwner);
      const runningUpdated = bothClaimed.claims["422"]?.updated ?? 0;
      await waitFor(async () => ((await schedulerState(first.statePath)).claims["422"]?.updated ?? 0) > runningUpdated);
      expect.soft(await pathExists(`/proc/${firstPid}`)).toBe(true);
      expect.soft(await recordedLines(terminationsPath)).not.toContain(firstOwner);
    } finally {
      await writeFile(releasePath, "release");
      await Promise.all([stopScheduler(first), stopScheduler(second)]);
      await stopRecordedProcesses(startsPath);
    }
  }, 10_000);

  it("keeps both capacities alive when a completed trigger could have a swapped assignment", async () => {
    // Given
    const directory = await schedulerDirectory("swapped-capacity-assignment");
    const startsPath = join(directory, "supervisor-starts");
    const terminationsPath = join(directory, "supervisor-terminations");
    const postLossHeartbeatsPath = join(directory, "post-loss-heartbeats");
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
printf '%s %s\n' "$DIM_QEMU_CI_CAPACITY" "$$" >> ${JSON.stringify(startsPath)}
trap 'printf "%s\n" "$DIM_QEMU_CI_CAPACITY" >> ${JSON.stringify(terminationsPath)}; exit 0' TERM
python3 -c 'import signal; signal.pause()' &
wait "$!"
`);
    const pythonSetup = `
real_locked_update = locked_update
real_shutdown_wait = shutdown.wait
renewal_stopped = False
def observed_locked_update(update):
    global renewal_stopped
    result = real_locked_update(update)
    if update.__name__ == "renew" and not result:
        renewal_stopped = True
    return result
def observed_shutdown_wait(timeout=None):
    result = real_shutdown_wait(timeout)
    if timeout == heartbeat_seconds and renewal_stopped:
        with open(${JSON.stringify(postLossHeartbeatsPath)}, "a", encoding="utf-8") as heartbeats:
            heartbeats.write(capacity + "\\n")
    return result
locked_update = observed_locked_update
shutdown.wait = observed_shutdown_wait`;
    const first = await startScheduler(directory, { capacity: "capacity-swap-1", pythonSetup });
    const second = await startScheduler(directory, { capacity: "capacity-swap-2", pythonSetup });

    try {
      await sendWorkflowJob(first.port, 425, "queued");
      await sendWorkflowJob(second.port, 426, "queued");
      await waitFor(async () => {
        const claims = (await schedulerState(first.statePath)).claims;
        return claims["425"] !== undefined && claims["426"] !== undefined
          && claims["425"].owner !== claims["426"].owner;
      });
      await waitFor(async () => (await recordedLines(startsPath)).length === 2);
      const claims = (await schedulerState(first.statePath)).claims;
      const firstTriggerOwner = claims["425"]?.owner ?? "";
      const secondTriggerOwner = claims["426"]?.owner ?? "";
      const starts = await recordedLines(startsPath);
      const firstTriggerStart = starts.find((line) => line.startsWith(`${firstTriggerOwner} `));
      const secondTriggerStart = starts.find((line) => line.startsWith(`${secondTriggerOwner} `));
      const firstTriggerPid = Number(firstTriggerStart?.split(" ")[1] ?? "0");
      const secondTriggerPid = Number(secondTriggerStart?.split(" ")[1] ?? "0");

      // When
      await sendWorkflowJob(first.port, 425, "completed");
      await waitFor(async () => (
        await recordedLines(postLossHeartbeatsPath)
      ).filter((owner) => owner === firstTriggerOwner).length >= 2);

      // Then
      expect.soft(await pathExists(`/proc/${firstTriggerPid}`)).toBe(true);
      expect.soft(await pathExists(`/proc/${secondTriggerPid}`)).toBe(true);
      expect.soft(await recordedLines(terminationsPath)).not.toContain(firstTriggerOwner);
      expect.soft(await recordedLines(terminationsPath)).not.toContain(secondTriggerOwner);
      expect.soft(await schedulerState(first.statePath)).toMatchObject({
        queued: [426],
        claims: { "426": { owner: secondTriggerOwner } },
        completed: { "425": expect.any(Number) }
      });
    } finally {
      await Promise.all([stopScheduler(first), stopScheduler(second)]);
      await stopRecordedProcesses(startsPath);
    }
  }, 10_000);

  it("retains an in-progress claim when its supervisor exits before completion", async () => {
    // Given
    const directory = await schedulerDirectory("running-supervisor-exit");
    const releasePath = join(directory, "release-supervisor");
    const releaseObservedPath = join(directory, "claim-release-observed");
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
while [[ ! -f ${JSON.stringify(releasePath)} ]]; do sleep 0.02; done
`);
    const scheduler = await startScheduler(directory, {
      capacity: "capacity-running-exit",
      pythonSetup: `
real_locked_update = locked_update
def observed_locked_update(update):
    result = real_locked_update(update)
    if update.__name__ == "release_claim":
        with open(${JSON.stringify(releaseObservedPath)}, "w", encoding="utf-8"):
            pass
    return result
locked_update = observed_locked_update`
    });

    try {
      await sendWorkflowJob(scheduler.port, 424, "queued");
      await waitFor(async () => (await schedulerState(scheduler.statePath)).claims["424"] !== undefined);
      await sendWorkflowJob(scheduler.port, 424, "in_progress");

      // When
      await writeFile(releasePath, "release");
      await waitFor(async () => pathExists(releaseObservedPath));

      // Then
      expect(await schedulerState(scheduler.statePath)).toMatchObject({
        queued: [],
        running: [424],
        claims: { "424": { owner: "capacity-running-exit" } }
      });
    } finally {
      await stopScheduler(scheduler);
    }
  });
}
