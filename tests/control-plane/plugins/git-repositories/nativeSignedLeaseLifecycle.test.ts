import { describe, expect, it } from "vitest";
import { createRootReadLeaseRegistry } from "../../../../packages/control-plane/plugins/git-repositories/src/native-root-read-lifecycle.js";
import { createWorkspaceWriteLeaseRegistry } from "../../../../packages/control-plane/plugins/git-repositories/src/native-workspace-write-lifecycle.js";

const generationId = "a".repeat(64);

describe("stateless native Git leases", () => {
  it("authenticates concurrent distinct workspace scopes with constant registry state", async () => {
    let now = 1_000;
    const registry = createWorkspaceWriteLeaseRegistry(() => now);
    const leases = await Promise.all(Array.from({ length: 64 }, async (_, index) => registry.issue({
      generationId, ownerHostId: "host-a", projectId: "project", repositoryId: `repo-${index}`,
      workspaceId: Buffer.alloc(32, index + 1).toString("base64url")
    })));
    for (const lease of leases) expect(registry.authenticate(lease)).toEqual({ generationId, ownerHostId: "host-a",
      projectId: "project", repositoryId: lease.repositoryId, workspaceId: lease.workspaceId });
    now = leases[0]!.expiresAt;
    expect(registry.authenticate(leases[0]!)).toBeUndefined();
  });

  it("rejects tampering and rotates all workspace-write credentials on clear", () => {
    const registry = createWorkspaceWriteLeaseRegistry(() => 1_000);
    const lease = registry.issue({ generationId, ownerHostId: "host-a", projectId: "project", repositoryId: "repo",
      workspaceId: Buffer.alloc(32, 1).toString("base64url") });
    const tail = lease.password.endsWith("A") ? "B" : "A";
    expect(registry.authenticate({ username: lease.username, password: `${lease.password.slice(0, -1)}${tail}` })).toBeUndefined();
    expect(registry.authenticate({ username: `${lease.username}x`, password: lease.password })).toBeUndefined();
    expect(registry.authenticate({ username: lease.username, password: lease.password.slice(0, -10) })).toBeUndefined();
    expect(registry.authenticate({ username: lease.username, password: `${lease.password}=` })).toBeUndefined();
    expect(registry.authenticate({ username: lease.username, password: "A".repeat(2801) })).toBeUndefined();
    const refreshed = registry.issue({ generationId, ownerHostId: "host-a", projectId: "project", repositoryId: "repo",
      workspaceId: Buffer.alloc(32, 1).toString("base64url") });
    expect(registry.authenticate(lease)).toBeDefined(); expect(registry.authenticate(refreshed)).toBeDefined();
    registry.clear();
    expect(registry.authenticate(lease)).toBeUndefined();
    expect(registry.authenticate(refreshed)).toBeUndefined();
    const reissued = registry.issue({ generationId, ownerHostId: "host-a", projectId: "project", repositoryId: "repo",
      workspaceId: Buffer.alloc(32, 1).toString("base64url") });
    expect(registry.authenticate(reissued)).toBeDefined();
  });

  it("keeps root-read credentials separate and generation-scoped", () => {
    const registry = createRootReadLeaseRegistry(() => 1_000);
    const first = registry.issue({ generationId, ownerHostId: "host-a", projectId: "project", repositoryId: "repo" });
    const second = registry.issue({ generationId: "b".repeat(64), ownerHostId: "host-a", projectId: "project", repositoryId: "repo" });
    expect(registry.authenticate(first)?.generationId).toBe(generationId);
    expect(registry.authenticate(second)?.generationId).toBe("b".repeat(64));
    expect(first.password).not.toBe(second.password);
  });

  it("keeps root-read and workspace-write credentials mutually invalid", () => {
    const root = createRootReadLeaseRegistry(() => 1_000), workspace = createWorkspaceWriteLeaseRegistry(() => 1_000);
    const read = root.issue({ generationId, ownerHostId: "host-a", projectId: "project", repositoryId: "repo" });
    const write = workspace.issue({ generationId, ownerHostId: "host-a", projectId: "project", repositoryId: "repo",
      workspaceId: Buffer.alloc(32, 2).toString("base64url") });
    expect(workspace.authenticate(read)).toBeUndefined(); expect(root.authenticate(write)).toBeUndefined();
  });
});
