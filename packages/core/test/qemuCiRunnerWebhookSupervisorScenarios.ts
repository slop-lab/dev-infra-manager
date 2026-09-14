import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  conditionWithin,
  killRecordedProcesses,
  pathExists,
  recordedLines,
  recordedPids,
  schedulerDirectory,
  schedulerState,
  sendWorkflowJob,
  startScheduler,
  stopRecordedProcesses,
  stopScheduler,
  waitFor
} from "./qemuCiRunnerWebhookHarness.js";

export function registerWebhookSupervisorScenarios(): void {
  it("kills and reaps a TERM-ignoring supervisor tree before claim release and replacement", async () => {
    // Given
    const directory = await schedulerDirectory("supervisor-tree-kill");
    const wrapperPidsPath = join(directory, "wrapper-pids");
    const descendantPidsPath = join(directory, "descendant-pids");
    const overlappingStartPath = join(directory, "overlapping-supervisor-tree");
    const prematureReleasePath = join(directory, "premature-tree-release");
    const renewFailurePath = join(directory, "tree-renew-failure");
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
trap '' TERM
if [[ -s ${JSON.stringify(wrapperPidsPath)} && -s ${JSON.stringify(descendantPidsPath)} ]]; then
  IFS= read -r first_wrapper < ${JSON.stringify(wrapperPidsPath)}
  IFS= read -r first_descendant < ${JSON.stringify(descendantPidsPath)}
  if kill -0 "$first_wrapper" 2>/dev/null || kill -0 "$first_descendant" 2>/dev/null; then
    : > ${JSON.stringify(overlappingStartPath)}
  fi
fi
printf '%s\\n' "$$" >> ${JSON.stringify(wrapperPidsPath)}
python3 - ${JSON.stringify(descendantPidsPath)} <<'PY' &
import os
import signal
import sys

signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(sys.argv[1], "a", encoding="utf-8") as output:
    output.write(f"{os.getpid()}\\n")
while True:
    signal.pause()
PY
descendant="$!"
wait "$descendant"
`);
    const scheduler = await startScheduler(directory, {
      capacity: "capacity-tree-kill",
      supervisorWaitTimeoutSeconds: 0.2,
      pythonSetup: `
real_locked_update = locked_update
renew_failure_pending = True
def injected_locked_update(update):
    global renew_failure_pending
    if update.__name__ == "renew" and renew_failure_pending and os.path.exists(${JSON.stringify(descendantPidsPath)}):
        renew_failure_pending = False
        with open(${JSON.stringify(renewFailurePath)}, "w", encoding="utf-8") as marker:
            marker.write("failed")
        raise OSError("injected tree heartbeat state failure")
    if update.__name__ == "release_claim":
        with open(${JSON.stringify(wrapperPidsPath)}, encoding="utf-8") as wrappers:
            first_wrapper = wrappers.readline().strip()
        with open(${JSON.stringify(descendantPidsPath)}, encoding="utf-8") as descendants:
            first_descendant = descendants.readline().strip()
        if os.path.exists("/proc/" + first_wrapper) or os.path.exists("/proc/" + first_descendant):
            with open(${JSON.stringify(prematureReleasePath)}, "w", encoding="utf-8") as marker:
                marker.write(first_wrapper + " " + first_descendant)
    return real_locked_update(update)
locked_update = injected_locked_update`
    });

    try {
      await sendWorkflowJob(scheduler.port, 416, "queued");
      await waitFor(async () => pathExists(renewFailurePath));

      // When
      const replacementStarted = await conditionWithin(async () =>
        (await recordedPids(wrapperPidsPath)).length === 2 && (await recordedPids(descendantPidsPath)).length === 2
      );

      // Then
      const wrapperPids = await recordedPids(wrapperPidsPath);
      const descendantPids = await recordedPids(descendantPidsPath);
      const firstWrapper = wrapperPids[0];
      const firstDescendant = descendantPids[0];
      expect.soft(replacementStarted).toBe(true);
      expect.soft(await pathExists(prematureReleasePath)).toBe(false);
      expect.soft(await pathExists(overlappingStartPath)).toBe(false);
      expect.soft(firstWrapper === undefined ? false : !(await pathExists(`/proc/${firstWrapper}`))).toBe(true);
      expect.soft(firstDescendant === undefined ? false : !(await pathExists(`/proc/${firstDescendant}`))).toBe(true);
      expect.soft(await schedulerState(scheduler.statePath)).toMatchObject({
        queued: [416], claims: { "416": { owner: "capacity-tree-kill" } }
      });
      expect.soft((await fetch(`http://127.0.0.1:${scheduler.port}/missing`)).status).toBe(501);
    } finally {
      await stopScheduler(scheduler);
      await killRecordedProcesses([wrapperPidsPath, descendantPidsPath]);
    }
  }, 15_000);

  it("retries a one-shot claim release failure before starting replacement work", async () => {
    // Given
    const directory = await schedulerDirectory("claim-release-failure");
    const startsPath = join(directory, "supervisor-starts");
    const releaseAttemptsPath = join(directory, "release-attempts");
    const releaseFailurePath = join(directory, "release-failure");
    const overlappingStartPath = join(directory, "overlapping-supervisor-start");
    const releasePath = join(directory, "release-supervisor");
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
if [[ ! -s ${JSON.stringify(startsPath)} ]]; then
  printf '%s\\n' "$$" >> ${JSON.stringify(startsPath)}
  exit 0
fi
IFS= read -r first_pid < ${JSON.stringify(startsPath)}
if kill -0 "$first_pid" 2>/dev/null; then
  : > ${JSON.stringify(overlappingStartPath)}
fi
printf '%s\\n' "$$" >> ${JSON.stringify(startsPath)}
while [[ ! -f ${JSON.stringify(releasePath)} ]]; do sleep 0.02; done
`);
    const scheduler = await startScheduler(directory, {
      capacity: "capacity-release-failure",
      pythonSetup: `
real_locked_update = locked_update
release_failure_pending = True
def injected_locked_update(update):
    global release_failure_pending
    if update.__name__ == "release_claim":
        with open(${JSON.stringify(releaseAttemptsPath)}, "a", encoding="utf-8") as attempts:
            attempts.write("release\\n")
        if release_failure_pending:
            release_failure_pending = False
            with open(${JSON.stringify(releaseFailurePath)}, "w", encoding="utf-8") as marker:
                marker.write("failed")
            raise OSError("injected claim release state failure")
    return real_locked_update(update)
locked_update = injected_locked_update`
    });

    try {
      await sendWorkflowJob(scheduler.port, 417, "queued");
      await waitFor(async () => pathExists(releaseFailurePath));

      // When
      const replacementStarted = await conditionWithin(async () => (await recordedPids(startsPath)).length === 2);

      // Then
      expect.soft(replacementStarted).toBe(true);
      expect.soft(await recordedLines(releaseAttemptsPath)).toHaveLength(2);
      expect.soft(await recordedPids(startsPath)).toHaveLength(2);
      expect.soft(await pathExists(overlappingStartPath)).toBe(false);
      expect.soft(await schedulerState(scheduler.statePath)).toMatchObject({
        queued: [417], claims: { "417": { owner: "capacity-release-failure" } }
      });
      expect.soft((await fetch(`http://127.0.0.1:${scheduler.port}/missing`)).status).toBe(501);
    } finally {
      await writeFile(releasePath, "release");
      await stopScheduler(scheduler);
      await stopRecordedProcesses(startsPath);
    }
  }, 15_000);

  it("reclaims an expired lease from a stopped capacity", async () => {
    // Given
    const directory = await schedulerDirectory("expired-lease");
    const statePath = join(directory, "demand.json");
    const releasePath = join(directory, "release-supervisor");
    await writeFile(statePath, JSON.stringify({
      queued: [412],
      running: [],
      claims: { "412": { owner: "stopped-capacity", updated: 0 } },
      completed: {}
    }));
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
while [[ ! -f '${releasePath}' ]]; do sleep 0.02; done
`);

    // When
    const scheduler = await startScheduler(directory, { capacity: "replacement-capacity" });

    try {
      // Then
      await waitFor(async () => (await schedulerState(statePath)).claims["412"]?.owner === "replacement-capacity");
      expect((await schedulerState(statePath)).queued).toEqual([412]);
    } finally {
      await writeFile(releasePath, "release");
      await stopScheduler(scheduler);
    }
  });
}
