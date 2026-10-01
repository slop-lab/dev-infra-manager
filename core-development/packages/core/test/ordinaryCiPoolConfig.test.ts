import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readOrdinaryCiPoolConnection,
  readOrdinaryCiPoolServiceConfig
} from "../../../../core/packages/core/src/ordinaryCiPoolConfig.js";

const roots: string[] = [];
const IMAGE = `registry.example/dim/job@sha256:${"a".repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ordinary CI pool private configuration", () => {
  it("parses explicit DIM organization enrollment and host capacities", async () => {
    // Given
    const file = await privateFile("service.json", {
      schemaVersion: 1,
      listen: { host: "127.0.0.1", port: 9081 },
      database: "/var/lib/dim-ordinary-pool/pool.sqlite3",
      jobImage: IMAGE,
      runnerLabel: "dim-ordinary",
      projects: [{ projectId: "project-a", projectName: "alpha", organization: "dim-alpha", organizationId: 41, webhookToken: "webhook-secret" }],
      hosts: [{ hostId: "host-a", token: "host-secret", capacities: ["primary"] }]
    });

    // When
    const parsed = await readOrdinaryCiPoolServiceConfig(file);

    // Then
    expect(parsed.listen).toEqual({ host: "127.0.0.1", port: 9081 });
    expect(parsed.pool.projects[0]?.organization).toBe("dim-alpha");
  });

  it("rejects public connection files and mutable expected job images", async () => {
    // Given
    const file = await privateFile("connection.json", {
      schemaVersion: 1,
      transport: "loopback-http",
      endpoint: "http://127.0.0.1:9081",
      hostId: "host-a",
      token: "host-secret",
      expectedJobImage: "registry.example/dim/job:latest"
    });

    // When / Then
    await expect(readOrdinaryCiPoolConnection(file)).rejects.toThrow(/digest-pinned/);
    await chmod(file, 0o644);
    await expect(readOrdinaryCiPoolConnection(file)).rejects.toThrow(/mode 0600/);
  });

  it("reports a missing operator config as an input error", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-pool-config-"));
    roots.push(root);

    // When
    const missing = readOrdinaryCiPoolServiceConfig(join(root, "missing.json"));

    // Then
    await expect(missing).rejects.toThrow(/ordinary CI pool config file does not exist/);
  });
});

async function privateFile(name: string, value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-ordinary-pool-config-"));
  roots.push(root);
  const file = join(root, name);
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return file;
}
