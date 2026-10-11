import { spawn } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  pathExists,
  recordedPids,
  recordedProcessesStopped,
  schedulerDirectory,
  schedulerState,
  sendWorkflowJob,
  signalScheduler,
  startScheduler,
  stopRecordedProcesses,
  stopScheduler,
  waitFor
} from "./qemuCiRunnerWebhookHarness.js";

export function registerWebhookShutdownScenarios(): void {
  it.each(["SIGTERM", "SIGINT"] as const)("stops claiming and waits for active supervisor cleanup on %s", async (shutdownSignal) => {
    const directory = await schedulerDirectory(`shutdown-${shutdownSignal.toLowerCase()}`);
    const activeRunPath = join(directory, "runs", "job-active");
    const runnerPath = join(activeRunPath, ".runner");
    const cleanupPath = join(directory, "supervisor-cleaned");
    const startsPath = join(directory, "supervisor-starts");
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
printf '%s\n' "$$" >> ${JSON.stringify(startsPath)}
mkdir -p ${JSON.stringify(activeRunPath)}
: > ${JSON.stringify(runnerPath)}
cleanup() {
  rm -rf -- ${JSON.stringify(activeRunPath)}
  : > ${JSON.stringify(cleanupPath)}
}
trap 'cleanup; exit 0' TERM INT
python3 -c 'import signal; signal.pause()' &
wait "$!"
`);
    const scheduler = await startScheduler(directory, { capacity: `capacity-${shutdownSignal.toLowerCase()}` });

    try {
      await sendWorkflowJob(scheduler.port, 418, "queued");
      await waitFor(async () => pathExists(runnerPath));

      const closed = signalScheduler(scheduler, shutdownSignal);

      await expect(closed).resolves.toBe(true);
      expect.soft(await pathExists(cleanupPath)).toBe(true);
      expect.soft(await pathExists(runnerPath)).toBe(false);
      expect.soft(await recordedPids(startsPath)).toHaveLength(1);
      expect.soft(await recordedProcessesStopped(await recordedPids(startsPath))).toBe(true);
    } finally {
      await stopScheduler(scheduler);
      await stopRecordedProcesses(startsPath);
    }
  }, 10_000);

  it("sweeps direct startup residue without following run-directory symlinks before claiming", async () => {
    const directory = await schedulerDirectory("startup-residue");
    const runRoot = join(directory, "runs");
    const residuePath = join(runRoot, "job-residue");
    const outsidePath = join(directory, "outside");
    const linkedPath = join(runRoot, "job-linked");
    const filePath = join(runRoot, "job-file");
    const startedPath = join(directory, "supervisor-started");
    await mkdir(residuePath, { recursive: true });
    await mkdir(outsidePath);
    await writeFile(join(residuePath, ".runner"), "credential residue");
    await writeFile(join(residuePath, "root.qcow2"), "overlay residue");
    await writeFile(join(outsidePath, "sentinel"), "outside");
    await symlink(outsidePath, linkedPath, "dir");
    await writeFile(filePath, "file residue");
    await writeFile(join(directory, "demand.json"), JSON.stringify({
      queued: [419], running: [], claims: {}, completed: {}
    }));
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
[[ ! -e ${JSON.stringify(residuePath)} ]]
[[ ! -e ${JSON.stringify(linkedPath)} ]]
[[ ! -e ${JSON.stringify(filePath)} ]]
[[ -f ${JSON.stringify(join(outsidePath, "sentinel"))} ]]
: > ${JSON.stringify(startedPath)}
python3 -c 'import signal; signal.pause()' &
wait "$!"
`);

    const scheduler = await startScheduler(directory, { capacity: "capacity-residue" });

    try {
      await waitFor(async () => pathExists(startedPath));
      expect.soft(await pathExists(residuePath)).toBe(false);
      expect.soft(await pathExists(linkedPath)).toBe(false);
      expect.soft(await pathExists(filePath)).toBe(false);
      expect.soft(await readFile(join(outsidePath, "sentinel"), "utf8")).toBe("outside");
    } finally {
      await stopScheduler(scheduler);
    }
  });

  it("does not claim queued work when shutdown arrives while state lock acquisition is blocked", async () => {
    const directory = await schedulerDirectory("shutdown-blocked-claim");
    const statePath = join(directory, "demand.json");
    const lockAttemptedPath = join(directory, "state-lock-attempted");
    const shutdownHandledPath = join(directory, "shutdown-handled");
    const claimResultPath = join(directory, "claim-result");
    const startsPath = join(directory, "supervisor-starts");
    await writeFile(statePath, JSON.stringify({ queued: [421], running: [], claims: {}, completed: {} }));
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
: > ${JSON.stringify(startsPath)}
`);
    const lockHolder = spawn("python3", ["-c", `
import fcntl
import sys
lock = open(sys.argv[1], "a+", encoding="utf-8")
fcntl.flock(lock, fcntl.LOCK_EX)
print("locked", flush=True)
sys.stdin.read(1)
`, `${statePath}.lock`], { stdio: ["pipe", "pipe", "ignore"] });
    const lockHolderClosed = new Promise<void>((resolve) => lockHolder.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      lockHolder.once("error", reject);
      lockHolder.stdout.once("data", () => resolve());
    });
    const scheduler = await startScheduler(directory, {
      capacity: "capacity-shutdown-race",
      shutdownMarkerPath: shutdownHandledPath,
      pythonSetup: `
real_flock = fcntl.flock
real_locked_update = locked_update
def observed_flock(descriptor, operation):
    if operation == fcntl.LOCK_EX:
        with open(${JSON.stringify(lockAttemptedPath)}, "w", encoding="utf-8"):
            pass
    return real_flock(descriptor, operation)
def observed_locked_update(update):
    result = real_locked_update(update)
    if update.__name__ == "claim_one":
        with open(${JSON.stringify(claimResultPath)}, "w", encoding="utf-8") as output:
            output.write(repr(result))
    return result
fcntl.flock = observed_flock
locked_update = observed_locked_update`
    });
    await waitFor(async () => pathExists(lockAttemptedPath));
    let lockReleased = false;

    try {
      const schedulerClosed = signalScheduler(scheduler, "SIGTERM");
      await waitFor(async () => pathExists(shutdownHandledPath));
      lockHolder.stdin.end("release");
      lockReleased = true;
      await lockHolderClosed;
      const closed = await schedulerClosed;

      expect.soft(closed).toBe(true);
      expect.soft(await readFile(claimResultPath, "utf8")).toBe("None");
      expect.soft(await pathExists(startsPath)).toBe(false);
      expect.soft(await schedulerState(statePath)).toMatchObject({
        queued: [421], claims: {}
      });
    } finally {
      if (!lockReleased) lockHolder.stdin.end("release");
      await lockHolderClosed;
      await stopScheduler(scheduler);
    }
  });
}
