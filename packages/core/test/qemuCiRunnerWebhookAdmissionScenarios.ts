import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  schedulerDirectory,
  schedulerState,
  sendWorkflowJob,
  startScheduler,
  stopScheduler,
  waitFor,
  workflowJobStatus
} from "./qemuCiRunnerWebhookHarness.js";

export function registerWebhookAdmissionScenarios(): void {
  it("dispatches admitted integration labels and dim-qemu but ignores ordinary labels", async () => {
    // Given
    const directory = await schedulerDirectory("admitted-labels");
    const scheduler = await startScheduler(directory, {
      capacity: "capacity-1",
      labels: ["dim-container-integration", "dim-qemu"],
      startWorker: false
    });

    try {
      // When
      await workflowJobStatus(scheduler.port, 400, "queued", ["dim"]);
      await workflowJobStatus(scheduler.port, 401, "queued", ["dim-container-integration"]);
      await workflowJobStatus(scheduler.port, 402, "queued", ["dim-qemu"]);

      // Then
      expect(await schedulerState(scheduler.statePath)).toMatchObject({ queued: [401, 402] });
    } finally {
      await stopScheduler(scheduler);
    }
  });

  it("keeps a completed job terminal when a queued event arrives late", async () => {
    // Given
    const directory = await schedulerDirectory("completed-queued");
    const scheduler = await startScheduler(directory, { capacity: "capacity-1" });

    try {
      await sendWorkflowJob(scheduler.port, 401, "completed");

      // When
      await sendWorkflowJob(scheduler.port, 401, "queued");

      // Then
      expect(await schedulerState(scheduler.statePath)).toMatchObject({
        queued: [], running: [], claims: {}, completed: { "401": expect.any(Number) }
      });
    } finally {
      await stopScheduler(scheduler);
    }
  });

  it("keeps a completed job terminal when an in-progress event arrives late", async () => {
    // Given
    const directory = await schedulerDirectory("completed-running");
    const scheduler = await startScheduler(directory, { capacity: "capacity-1" });

    try {
      await sendWorkflowJob(scheduler.port, 402, "completed");

      // When
      await sendWorkflowJob(scheduler.port, 402, "in_progress");

      // Then
      expect(await schedulerState(scheduler.statePath)).toMatchObject({
        queued: [], running: [], claims: {}, completed: { "402": expect.any(Number) }
      });
    } finally {
      await stopScheduler(scheduler);
    }
  });

  it("keeps an in-progress job ahead of a late queued event", async () => {
    // Given
    const directory = await schedulerDirectory("running-queued");
    const scheduler = await startScheduler(directory, { capacity: "capacity-1" });
    try {
      await sendWorkflowJob(scheduler.port, 403, "in_progress");

      // When
      await sendWorkflowJob(scheduler.port, 403, "queued");

      // Then
      expect(await schedulerState(scheduler.statePath)).toMatchObject({ queued: [], running: [403], claims: {} });
    } finally {
      await stopScheduler(scheduler);
    }
  });

  it("records duplicate completed deliveries idempotently", async () => {
    // Given
    const directory = await schedulerDirectory("duplicate-completed");
    const scheduler = await startScheduler(directory, { capacity: "capacity-1" });
    try {
      await sendWorkflowJob(scheduler.port, 404, "completed");
      const first = await schedulerState(scheduler.statePath);

      // When
      await sendWorkflowJob(scheduler.port, 404, "completed");

      // Then
      expect(await schedulerState(scheduler.statePath)).toEqual(first);
      expect(first.completed?.["404"]).toEqual(expect.any(Number));
    } finally {
      await stopScheduler(scheduler);
    }
  });

  it("prunes terminal markers only after the seven-day retention window", async () => {
    // Given
    const directory = await schedulerDirectory("completed-retention");
    const statePath = join(directory, "demand.json");
    const retainedAt = Date.now() / 1000;
    await writeFile(statePath, JSON.stringify({
      queued: [], running: [], claims: {}, completed: { "407": 0, "408": retainedAt }
    }));
    const scheduler = await startScheduler(directory, { capacity: "capacity-1" });

    try {
      // When
      await sendWorkflowJob(scheduler.port, 409, "in_progress");

      // Then
      expect((await schedulerState(statePath)).completed).toEqual({ "408": retainedAt });
    } finally {
      await stopScheduler(scheduler);
    }
  });

  it("retains completed precedence across a scheduler process restart", async () => {
    // Given
    const directory = await schedulerDirectory("completed-restart");
    const first = await startScheduler(directory, { capacity: "capacity-1" });
    await sendWorkflowJob(first.port, 405, "completed");
    await stopScheduler(first);
    const restarted = await startScheduler(directory, { capacity: "capacity-1" });

    try {
      // When
      await sendWorkflowJob(restarted.port, 405, "queued");

      // Then
      expect(await schedulerState(restarted.statePath)).toMatchObject({
        queued: [], running: [], claims: {}, completed: { "405": expect.any(Number) }
      });
    } finally {
      await stopScheduler(restarted);
    }
  });

  it("recovers queued demand from a durable state after restart", async () => {
    // Given
    const directory = await schedulerDirectory("queued-restart");
    const first = await startScheduler(directory, { capacity: "capacity-1", startWorker: false });
    await sendWorkflowJob(first.port, 410, "queued");
    await stopScheduler(first);

    // When
    const restarted = await startScheduler(directory, { capacity: "capacity-1", startWorker: false });

    try {
      // Then
      expect(await schedulerState(restarted.statePath)).toEqual({
        queued: [410], running: [], claims: {}, completed: {}
      });
    } finally {
      await stopScheduler(restarted);
    }
  });

  it("renews an active claim while its supervisor is running", async () => {
    // Given
    const directory = await schedulerDirectory("claim-renewal");
    const releasePath = join(directory, "release-supervisor");
    await writeFile(join(directory, "supervise.bash"), `#!/usr/bin/env bash
set -eu
while [[ ! -f '${releasePath}' ]]; do sleep 0.02; done
`);
    const scheduler = await startScheduler(directory, { capacity: "capacity-renewal" });

    try {
      await sendWorkflowJob(scheduler.port, 411, "queued");
      await waitFor(async () => (await schedulerState(scheduler.statePath)).claims["411"] !== undefined);
      const firstUpdated = (await schedulerState(scheduler.statePath)).claims["411"]?.updated ?? 0;

      // When
      await waitFor(async () => ((await schedulerState(scheduler.statePath)).claims["411"]?.updated ?? 0) > firstUpdated);

      // Then
      expect((await schedulerState(scheduler.statePath)).claims["411"]).toMatchObject({ owner: "capacity-renewal" });
    } finally {
      await writeFile(releasePath, "release");
      await stopScheduler(scheduler);
    }
  });
}
