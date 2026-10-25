import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { nativeRepositoryPolicyRevision, parseAuthoritativeImportedRootPolicy, type NativeGitProjectAttachment } from "@slop-lab/dim-contracts-git";
import type { NativeControlPlaneConnection } from "../../../../packages/host/plugins/native-git/src/nativeControlPlaneConnection.js";

const mocks = vi.hoisted(() => ({ discover: vi.fn(), inspect: vi.fn(), readiness: vi.fn() }));
vi.mock("@slop-lab/dim-service-client-native-git", async (importOriginal) => ({
  ...await importOriginal<typeof import("@slop-lab/dim-service-client-native-git")>(),
  createNativeGitProjectAttachmentClient: () => ({ discover: mocks.discover, inspect: mocks.inspect })
}));
vi.mock("../../../../packages/host/plugins/native-git/src/nativeProjectReadinessClient.js", () => ({
  proveNativeProjectReadiness: mocks.readiness
}));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("keeps 128-entry cross-host discovery and one-Project attachment bounded without sweeping unrelated repositories", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "dim-attachment-latency-"));
  roots.push(root);
  await mkdir(join(root, "state"), { mode: 0o700 });
  vi.stubEnv("DIM_MANAGED_STATE_ROOT", join(root, "state"));
  const generationId = "a".repeat(64);
  const selected: NativeControlPlaneConnection = {
    schemaVersion: 1,
    hostId: "source-host",
    nativeGit: {
      serviceId: "native-main",
      generationId,
      transport: "loopback-http",
      endpoint: "http://127.0.0.1:1",
      rootReadIssuer: { username: "reader", password: "r".repeat(32) },
      workspaceWriteIssuer: { username: "writer", password: "w".repeat(32) }
    }
  };
  const projects = Array.from({ length: 128 }, (_, index) => ({
    projectId: `project-${String(index).padStart(3, "0")}`,
    repositoryCount: 1
  }));
  const descriptor = attachment(generationId);
  mocks.discover.mockResolvedValue({ schemaVersion: 1, serviceId: "native-main", generationId,
    ownerHostId: selected.hostId, projects });
  mocks.inspect.mockImplementation(async (projectId: string) => {
    expect(projectId).toBe(descriptor.projectId);
    return descriptor;
  });
  mocks.readiness.mockResolvedValue({});
  const { createNativeProjectAttachmentManagement } = await import("../../../../packages/host/plugins/native-git/src/projectAttachment.js");
  const management = createNativeProjectAttachmentManagement(selected, process.env);

  // When
  const discoveryStarted = performance.now();
  const discovered = await management.invoke("projects.discover", {});
  const discoveryMilliseconds = performance.now() - discoveryStarted;
  const attachStarted = performance.now();
  const attached = await management.invoke("projects.attach", {
    projectId: descriptor.projectId,
    configurationRepositoryId: "working",
    defaultWorkingRepositoryId: "working"
  });
  const attachMilliseconds = performance.now() - attachStarted;

  // Then
  expect(discovered).toEqual({ projects });
  expect(attached).toEqual({ projectId: descriptor.projectId, repositoryCount: 1 });
  expect(discoveryMilliseconds).toBeLessThan(2_000);
  expect(attachMilliseconds).toBeLessThan(2_000);
  expect(mocks.discover).toHaveBeenCalledTimes(1);
  expect(mocks.inspect).toHaveBeenCalledTimes(1);
  expect(mocks.readiness).toHaveBeenCalledTimes(1);
  console.info(JSON.stringify({ discoveryMilliseconds, attachMilliseconds, catalogEntries: projects.length,
    inspectedProjects: mocks.inspect.mock.calls.length, readinessProofs: mocks.readiness.mock.calls.length }));
});

it("keeps the host attachment operation alive beyond the former ten-second descriptor limit", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "dim-attachment-deadline-"));
  roots.push(root);
  await mkdir(join(root, "state"), { mode: 0o700 });
  vi.stubEnv("DIM_MANAGED_STATE_ROOT", join(root, "state"));
  const generationId = "a".repeat(64);
  const selected: NativeControlPlaneConnection = {
    schemaVersion: 1,
    hostId: "source-host",
    nativeGit: {
      serviceId: "native-main",
      generationId,
      transport: "loopback-http",
      endpoint: "http://127.0.0.1:1",
      rootReadIssuer: { username: "reader", password: "r".repeat(32) },
      workspaceWriteIssuer: { username: "writer", password: "w".repeat(32) }
    }
  };
  const descriptor = attachment(generationId);
  mocks.inspect.mockImplementation(async (_projectId: string, signal: AbortSignal) => {
    await delay(10_200, undefined, { signal });
    return descriptor;
  });
  mocks.readiness.mockResolvedValue({});
  const { createNativeProjectAttachmentManagement } = await import("../../../../packages/host/plugins/native-git/src/projectAttachment.js");
  const management = createNativeProjectAttachmentManagement(selected, process.env);

  // When
  const started = performance.now();
  const attached = await management.invoke("projects.attach", {
    projectId: descriptor.projectId,
    configurationRepositoryId: "working",
    defaultWorkingRepositoryId: "working"
  });
  const elapsed = performance.now() - started;

  // Then
  expect(attached).toEqual({ projectId: descriptor.projectId, repositoryCount: 1 });
  expect(elapsed).toBeGreaterThanOrEqual(10_000);
  expect(elapsed).toBeLessThan(15_000);
}, 20_000);

function attachment(generationId: string): NativeGitProjectAttachment {
  const extensions = {};
  const input = { protectedRef: "refs/heads/main", extensions } as const;
  const policy = parseAuthoritativeImportedRootPolicy({ schemaVersion: 1, ...input,
    policyRevision: nativeRepositoryPolicyRevision(input) });
  const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const commit = "b".repeat(40);
  const tree = "c".repeat(40);
  return {
    schemaVersion: 1,
    serviceId: "native-main",
    generationId,
    ownerHostId: "source-host",
    projectId: "project-064",
    repositories: [{
      repositoryId: "working",
      importReceipt: { schemaVersion: 1, serviceId: "native-main", projectId: "project-064", repositoryId: "working",
        generationId, importNonce: randomUUID(), protectedRef: "refs/heads/main", expectedCommit: commit,
        policyDigest, bundleDigest: "d".repeat(64), bundleSize: 1, resolvedTree: tree, phase: "repository-imported" },
      importedPolicy: policy,
      effectivePolicy: policy,
      currentHead: { projectId: "project-064", repositoryId: "working", sequence: 0,
        protectedRef: "refs/heads/main", commit, tree, policyDigest }
    }]
  };
}
