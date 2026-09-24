import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureGiteaWebhookAllowedHosts,
  ensureGitea,
  giteaHostCloneUrl,
  giteaInternalCloneUrl,
  giteaNestedBaseUrl,
  giteaRunnerBaseUrl
} from "../../../../core/packages/core/src/gitea.js";
import { lifecycleOptionsForBackend } from "../../../../core/packages/core/src/lifecycleOptions.js";
import type { CommandRunner } from "../../../../core/packages/core/src/types.js";

describe("external Gitea connection", () => {
  const servers: Server[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("validates configured endpoints and credentials without provisioning Docker resources", async () => {
    // Given
    const endpoint = await authenticatedGiteaEndpoint(servers, "operator", "admin-secret");
    const connectionFile = await externalConnectionFile(roots, endpoint);
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_GITEA_CONNECTION_FILE: connectionFile
    });
    const runner = rejectingDockerRunner();

    // When
    const connection = await ensureGitea(runner, options);

    // Then
    expect(connection).toMatchObject({
      kind: "external",
      apiBaseUrl: `${endpoint}/api/v1`,
      hostBaseUrl: "https://git.host.example",
      workspaceBaseUrl: "https://git.workspace.example",
      runnerBaseUrl: "https://git.runner.example"
    });
    expect(giteaHostCloneUrl(connection, "dim-example", "root")).toBe("https://git.host.example/dim-example/root.git");
    expect(giteaInternalCloneUrl(connection, "dim-example", "root")).toBe("https://git.workspace.example/dim-example/root.git");
    await expect(giteaNestedBaseUrl(runner, connection)).resolves.toBe("https://git.workspace.example");
    await expect(giteaRunnerBaseUrl(runner, connection)).resolves.toBe("https://git.runner.example");
  });

  it("rejects invalid credentials before any Docker command", async () => {
    // Given
    const endpoint = await authenticatedGiteaEndpoint(servers, "operator", "admin-secret");
    const connectionFile = await externalConnectionFile(roots, endpoint, { adminPassword: "wrong-secret" });
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_GITEA_CONNECTION_FILE: connectionFile
    });

    // When / Then
    await expect(ensureGitea(rejectingDockerRunner(), options)).rejects.toThrow(/authenticate external Gitea/);
  });

  it("rejects a connection file readable by group or other users", async () => {
    // Given
    const endpoint = await authenticatedGiteaEndpoint(servers, "operator", "admin-secret");
    const connectionFile = await externalConnectionFile(roots, endpoint);
    await chmod(connectionFile, 0o644);
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_GITEA_CONNECTION_FILE: connectionFile
    });

    // When / Then
    await expect(ensureGitea(rejectingDockerRunner(), options)).rejects.toThrow(/mode 0600/);
  });

  it("rejects an invalid configured endpoint before any Docker command", async () => {
    // Given
    const endpoint = await authenticatedGiteaEndpoint(servers, "operator", "admin-secret");
    const connectionFile = await externalConnectionFile(roots, endpoint, {
      hostBaseUrl: "ssh://git.host.example"
    });
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_GITEA_CONNECTION_FILE: connectionFile
    });

    // When / Then
    await expect(ensureGitea(rejectingDockerRunner(), options)).rejects.toThrow(/hostBaseUrl.*HTTP or HTTPS/);
  });

  it("leaves external webhook policy to the operator", async () => {
    // Given
    const endpoint = await authenticatedGiteaEndpoint(servers, "operator", "admin-secret");
    const connectionFile = await externalConnectionFile(roots, endpoint);
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_GITEA_CONNECTION_FILE: connectionFile
    });

    // When / Then
    await expect(configureGiteaWebhookAllowedHosts(
      rejectingDockerRunner(),
      options,
      ["per-host-runner"]
    )).resolves.toBeUndefined();
  });
});

function rejectingDockerRunner(): CommandRunner {
  return {
    async run(command, args) {
      throw new Error(`external Gitea attempted command: ${[command, ...args].join(" ")}`);
    }
  };
}

async function authenticatedGiteaEndpoint(
  servers: Server[],
  username: string,
  password: string
): Promise<string> {
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/version") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: "test" }));
      return;
    }
    if (request.url === "/api/v1/user" && request.headers.authorization === expectedAuthorization) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ login: username }));
      return;
    }
    response.writeHead(401).end();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

async function externalConnectionFile(
  roots: string[],
  endpoint: string,
  override: { readonly adminPassword?: string; readonly hostBaseUrl?: string } = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-external-gitea-"));
  roots.push(root);
  const connectionFile = join(root, "connection.json");
  await writeFile(connectionFile, JSON.stringify({
    schemaVersion: 1,
    apiBaseUrl: `${endpoint}/api/v1`,
    hostBaseUrl: override.hostBaseUrl ?? "https://git.host.example",
    workspaceBaseUrl: "https://git.workspace.example",
    runnerBaseUrl: "https://git.runner.example",
    credentials: {
      adminUsername: "operator",
      adminPassword: override.adminPassword ?? "admin-secret",
      writerUsername: "workspace-writer",
      writerPassword: "writer-secret",
      maintainerUsername: "host-maintainer",
      maintainerPassword: "maintainer-secret"
    },
    projects: {
      example: {
        id: "shared-project-id",
        gitNamespace: "dim-example",
        giteaOrganizationId: 41
      }
    }
  }), { mode: 0o600 });
  return connectionFile;
}
