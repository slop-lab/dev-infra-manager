import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import type { GiteaProjectBinding } from "../../../../core/packages/core/src/lifecycleTypes.js";
import { runOrdinaryCiPoolCapacityOnce } from "../../../../core/packages/core/src/ordinaryCiPoolRuntime.js";
import { REGISTRY_CACHE_IMAGE } from "../../../../core/packages/core/src/registryCache.js";
import type { CommandResult, StreamingCommandRunner } from "../../../../core/packages/core/src/types.js";

const JOB_IMAGE = `registry.example/dim/job@sha256:${"a".repeat(64)}`;
const RUNNER_IMAGE = `sha256:${"b".repeat(64)}`;
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, "close");
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ordinary CI pool external Project binding", () => {
  it.each([
    ["missing", { alpha: binding("project-a", "dim-alpha", 41) }],
    ["mismatched", {
      alpha: binding("project-a", "dim-alpha", 41),
      beta: binding("wrong-project", "dim-beta", 42)
    }]
  ])("rejects a %s binding before organization registration", async (_case, projects) => {
    const root = await mkdtemp(join(tmpdir(), "dim-ordinary-runtime-binding-"));
    roots.push(root);
    let registrations = 0;
    const endpoint = await listen(createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://control").pathname;
      if (path === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, serviceId: "pool-main", jobImage: JOB_IMAGE }));
        return;
      }
      if (path === "/v1/claims") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          claimId: "claim-beta", admissionId: "a".repeat(64), serviceId: "pool-main", jobId: 203, projectId: "project-b", projectName: "beta",
          organization: "dim-beta", organizationId: 42, jobImage: JOB_IMAGE,
          sourceRef: "refs/heads/main", sourceCommit: "a".repeat(40), configDigest: "b".repeat(64),
          runnerLabels: ["dim-ordinary"], leaseMilliseconds: 60_000
        }));
        return;
      }
      if (path === "/v1/claims/claim-beta/release") {
        response.writeHead(204).end();
        return;
      }
      if (path.includes("/actions/runners/registration-token")) registrations += 1;
      response.writeHead(404).end();
    }));
    const options = await hostOptions(root, endpoint, projects);

    await expect(runOrdinaryCiPoolCapacityOnce(new NoopRunner(), options, "primary"))
      .rejects.toThrow(/not an enrolled external Gitea binding/);
    expect(registrations).toBe(0);
  });
});

class NoopRunner implements StreamingCommandRunner {
  async run(command: string, args: string[]): Promise<CommandResult> {
    const stdout = args[0] === "network" || args[0] === "volume" ? "true\n"
      : args[0] === "container" && args[2] === "dim-registry-cache" ? `true|true|${REGISTRY_CACHE_IMAGE}\n` : "";
    return { command, args, stdout, stderr: "", exitCode: 0 };
  }

  async runStreaming(): Promise<number> { return 0; }
}

function binding(id: string, gitNamespace: string, giteaOrganizationId: number): GiteaProjectBinding {
  return { id, gitNamespace, giteaOrganizationId };
}

async function hostOptions(
  root: string,
  endpoint: string,
  projects: Readonly<Record<string, GiteaProjectBinding>>
) {
  const giteaFile = join(root, "gitea.json");
  const poolFile = join(root, "pool.json");
  await writeFile(giteaFile, JSON.stringify({
    schemaVersion: 1, transport: "loopback-http", hostId: "host-a",
    apiBaseUrl: `${endpoint}/api/v1`, hostBaseUrl: endpoint, workspaceBaseUrl: endpoint, runnerBaseUrl: endpoint,
    credentials: {
      adminUsername: "admin", adminPassword: "admin-password",
      writerUsername: "writer", writerPassword: "writer-password",
      maintainerUsername: "maintainer", maintainerPassword: "maintainer-password"
    },
    projects
  }), { mode: 0o600 });
  await writeFile(poolFile, JSON.stringify({
    schemaVersion: 2, transport: "loopback-http", endpoint, hostId: "host-a",
    token: "host-token", expectedServiceId: "pool-main", expectedJobImage: JOB_IMAGE
  }), { mode: 0o600 });
  return lifecycleOptionsForBackend("sysbox", {
    HOME: root, DIM_STATE_ROOT: join(root, "state"), DIM_GITEA_CONNECTION_FILE: giteaFile,
    DIM_ORDINARY_CI_POOL_CONNECTION_FILE: poolFile, DIM_CI_RUNNER_IMAGE: RUNNER_IMAGE
  });
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
