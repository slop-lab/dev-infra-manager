import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitSyncConnection } from "../../../../core/packages/core/src/gitSyncConnection.js";
import type { LifecycleOptions } from "../../../../core/packages/core/src/lifecycleTypes.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Git sync connection", () => {
  it("parses a private explicit loopback service connection", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-git-sync-connection-"));
    cleanup.push(root);
    const file = join(root, "connection.json");
    await writeFile(file, JSON.stringify(connection()), { mode: 0o600 });
    await chmod(file, 0o600);

    // When
    const result = await gitSyncConnection({
      gitSyncConnection: { file },
      giteaConnection: { kind: "managed" }
    } as LifecycleOptions);

    // Then
    expect(result).toEqual({
      endpoint: "http://127.0.0.1:8080",
      hostId: "git-a",
      timeoutSeconds: 300,
      token: "service-secret"
    });
  });

  it("rejects a connection whose host identity differs from external Gitea", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-git-sync-identity-"));
    cleanup.push(root);
    const file = join(root, "connection.json");
    const gitea = join(root, "gitea.json");
    await writeFile(file, JSON.stringify(connection()), { mode: 0o600 });
    await writeFile(gitea, JSON.stringify({
      schemaVersion: 1,
      transport: "https",
      hostId: "git-b",
      apiBaseUrl: "https://control.example/api/v1",
      hostBaseUrl: "https://host.example",
      workspaceBaseUrl: "https://workspace.example",
      runnerBaseUrl: "https://runner.example",
      credentials: {
        adminUsername: "admin", adminPassword: "admin-secret",
        writerUsername: "writer", writerPassword: "writer-secret",
        maintainerUsername: "maintainer", maintainerPassword: "maintainer-secret"
      },
      projects: {}
    }), { mode: 0o600 });
    await Promise.all([chmod(file, 0o600), chmod(gitea, 0o600)]);

    // When / Then
    await expect(gitSyncConnection({
      gitSyncConnection: { file },
      giteaConnection: { kind: "external", file: gitea }
    } as LifecycleOptions)).rejects.toThrow(/host identity/);
  });
});

function connection(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    transport: "loopback-http",
    hostId: "git-a",
    endpoint: "http://127.0.0.1:8080",
    token: "service-secret",
    timeoutSeconds: 300
  };
}
