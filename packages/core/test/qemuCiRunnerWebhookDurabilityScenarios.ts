import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  pathExists,
  schedulerDirectory,
  schedulerState,
  sendWorkflowJob,
  startScheduler,
  stopScheduler,
  waitFor,
  workflowJobStatus
} from "./qemuCiRunnerWebhookHarness.js";

export function registerWebhookDurabilityScenarios(): void {
  it("serializes concurrent stale deliveries behind completed precedence", async () => {
    // Given
    const directory = await schedulerDirectory("concurrent-reordered");
    const first = await startScheduler(directory, { capacity: "capacity-1" });
    const second = await startScheduler(directory, { capacity: "capacity-2" });
    try {
      await sendWorkflowJob(first.port, 406, "completed");

      // When
      await Promise.all([
        sendWorkflowJob(first.port, 406, "queued"),
        sendWorkflowJob(second.port, 406, "in_progress"),
        sendWorkflowJob(first.port, 406, "queued"),
        sendWorkflowJob(second.port, 406, "in_progress")
      ]);

      // Then
      expect(await schedulerState(first.statePath)).toMatchObject({
        queued: [], running: [], claims: {}, completed: { "406": expect.any(Number) }
      });
    } finally {
      await Promise.all([stopScheduler(first), stopScheduler(second)]);
    }
  });

  it.each([
    ["truncated JSON", '{"queued":[501]'],
    ["missing schema field", JSON.stringify({ queued: [], running: [] })],
    ["unknown schema field", JSON.stringify({
      queued: [], running: [], claims: {}, completed: {}, extra: true
    })],
    ["wrong top-level shape", JSON.stringify(["queued", "running", "claims"])],
    ["wrong nested type", JSON.stringify({
      queued: [true], running: [], claims: {}, completed: {}
    })]
  ])("rejects accepted events when persisted state has %s", async (_description, persisted) => {
    // Given
    const directory = await schedulerDirectory("invalid-state");
    const statePath = join(directory, "demand.json");
    await writeFile(statePath, persisted);
    const scheduler = await startScheduler(directory, { capacity: "capacity-1", startWorker: false });

    try {
      // When
      const status = await workflowJobStatus(scheduler.port, 501, "queued");

      // Then
      expect(status).toBe(500);
      expect(await readFile(statePath, "utf8")).toBe(persisted);
    } finally {
      await stopScheduler(scheduler);
    }
  });

  it("rejects accepted events when the state file cannot be read", async () => {
    // Given
    const directory = await schedulerDirectory("state-read-failure");
    const statePath = join(directory, "demand.json");
    const persisted = JSON.stringify({ queued: [502], running: [], claims: {}, completed: {} });
    await writeFile(statePath, persisted);
    const scheduler = await startScheduler(directory, {
      capacity: "capacity-1",
      startWorker: false,
      pythonSetup: `
import builtins
real_open = builtins.open
def injected_open(file, mode="r", *args, **kwargs):
    if os.fspath(file) == state_path and mode == "r":
        raise PermissionError("injected state read failure")
    return real_open(file, mode, *args, **kwargs)
builtins.open = injected_open`
    });

    try {
      // When
      const status = await workflowJobStatus(scheduler.port, 503, "queued");

      // Then
      expect(status).toBe(500);
      expect(await readFile(statePath, "utf8")).toBe(persisted);
    } finally {
      await stopScheduler(scheduler);
    }
  });

  it.each([
    ["temporary-file write", `
import builtins
real_open = builtins.open
def injected_open(file, mode="r", *args, **kwargs):
    if os.fspath(file).startswith(state_path + ".") and mode == "w":
        raise PermissionError("injected state write failure")
    return real_open(file, mode, *args, **kwargs)
builtins.open = injected_open`],
    ["file fsync", `
import stat
real_fsync = os.fsync
def injected_fsync(descriptor):
    if stat.S_ISREG(os.fstat(descriptor).st_mode):
        raise OSError("injected file fsync failure")
    return real_fsync(descriptor)
os.fsync = injected_fsync`],
    ["atomic replace", `
def injected_replace(source, destination):
    raise OSError("injected replace failure")
os.replace = injected_replace`],
    ["directory fsync", `
import stat
real_fsync = os.fsync
def injected_fsync(descriptor):
    if stat.S_ISDIR(os.fstat(descriptor).st_mode):
        raise OSError("injected directory fsync failure")
    return real_fsync(descriptor)
os.fsync = injected_fsync`]
  ])("does not acknowledge an accepted event when %s fails", async (_description, pythonSetup) => {
    // Given
    const directory = await schedulerDirectory("state-save-failure");
    const statePath = join(directory, "demand.json");
    const persisted = JSON.stringify({ queued: [599], running: [], claims: {}, completed: {} });
    await writeFile(statePath, persisted);
    const scheduler = await startScheduler(directory, { capacity: "capacity-1", pythonSetup, startWorker: false });

    try {
      // When
      const status = await workflowJobStatus(scheduler.port, 504, "queued");

      // Then
      expect(status).toBe(500);
      if (_description !== "directory fsync") {
        expect(await readFile(statePath, "utf8")).toBe(persisted);
      }
    } finally {
      await stopScheduler(scheduler);
    }
  });

  it("acknowledges an accepted event only after directory fsync completes", async () => {
    // Given
    const directory = await schedulerDirectory("state-durability-order");
    const enteredPath = join(directory, "directory-fsync-entered");
    const releasePath = join(directory, "release-directory-fsync");
    const scheduler = await startScheduler(directory, {
      capacity: "capacity-1",
      startWorker: false,
      pythonSetup: `
import stat
real_fsync = os.fsync
def controlled_fsync(descriptor):
    if stat.S_ISDIR(os.fstat(descriptor).st_mode):
        with open(${JSON.stringify(enteredPath)}, "w", encoding="utf-8"):
            pass
        while not os.path.exists(${JSON.stringify(releasePath)}):
            time.sleep(0.01)
    return real_fsync(descriptor)
os.fsync = controlled_fsync`
    });

    try {
      let acknowledged = false;
      const pendingStatus = workflowJobStatus(scheduler.port, 505, "queued").then((status) => {
        acknowledged = true;
        return status;
      });
      await waitFor(async () => pathExists(enteredPath));

      // When
      const beforeDurability = acknowledged;
      await writeFile(releasePath, "release");

      // Then
      expect(beforeDurability).toBe(false);
      expect(await pendingStatus).toBe(202);
      expect(await schedulerState(scheduler.statePath)).toMatchObject({ queued: [505] });
    } finally {
      await stopScheduler(scheduler);
    }
  });
}
