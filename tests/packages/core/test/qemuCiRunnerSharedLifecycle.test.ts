import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureGiteaWebhookAllowedHosts } from "../../../../core/packages/core/src/gitea.js";
import { giteaCiCoordinator } from "../../../../core/packages/core/src/giteaCiCoordinator.js";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import type { CiRunnerRecord } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { lifecycleOptions, READY_QEMU_RECORD, TEST_PROJECT } from "./ciRunnerContainerFixture.js";

vi.mock("../../../../core/packages/core/src/gitea.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../core/packages/core/src/gitea.js")>(),
  configureGiteaWebhookAllowedHosts: vi.fn(async () => {})
}));

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared QEMU host lifecycle", () => {
  it("preserves the other host supervisor name when reconciling after host A deletion", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-shared-lifecycle-"));
    roots.push(root);
    const state = new LifecycleState(root);
    await state.claimProject(TEST_PROJECT);
    const hostA = sharedRecord("host-a-capacity", "host-a-supervisor", "host-a");
    const hostB = sharedRecord("host-b-capacity", "host-b-supervisor", "host-b");
    await state.writeCiRunner(hostA);
    await state.writeCiRunner(hostB);

    // When
    await giteaCiCoordinator.reconcileWorkflowJobWebhookTargets(
      { run: async (command, args) => ({ command, args, stdout: "", stderr: "", exitCode: 0 }) },
      lifecycleOptions(root),
      { project: hostA.projectName, name: hostA.name }
    );

    // Then
    expect(configureGiteaWebhookAllowedHosts).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), ["host-b-supervisor"]
    );
  });
});

function sharedRecord(name: string, supervisorName: string, hostId: string): CiRunnerRecord {
  return {
    ...READY_QEMU_RECORD,
    name,
    executor: {
      ...READY_QEMU_RECORD.executor,
      supervisorName,
      scheduler: { projectId: TEST_PROJECT.id, hostId }
    }
  };
}
