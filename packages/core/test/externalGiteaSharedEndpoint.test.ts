import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { configuredExternalGiteaConnection } from "../../../../core/packages/core/src/giteaExternalConnection.js";

it("allows host, workspace, and runner clients to use the same external Git URL", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "dim-shared-gitea-url-"));
  const file = join(root, "connection.json");
  const baseUrl = "https://git.example.test";
  try {
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      hostId: "host-a",
      transport: "https",
      apiBaseUrl: `${baseUrl}/api/v1`,
      hostBaseUrl: baseUrl,
      workspaceBaseUrl: baseUrl,
      runnerBaseUrl: baseUrl,
      credentials: {
        adminUsername: "operator", adminPassword: "host-secret",
        writerUsername: "agent", writerPassword: "agent-secret",
        maintainerUsername: "operator", maintainerPassword: "host-secret"
      },
      projects: {}
    }), { mode: 0o600 });

    // When
    const connection = await configuredExternalGiteaConnection(file);

    // Then
    expect(connection.hostBaseUrl).toBe(baseUrl);
    expect(connection.workspaceBaseUrl).toBe(baseUrl);
    expect(connection.runnerBaseUrl).toBe(baseUrl);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
