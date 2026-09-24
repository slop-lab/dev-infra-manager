import { once } from "node:events";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
      hostId: "host-a",
      apiBaseUrl: `${endpoint}/api/v1`,
      hostBaseUrl: `${endpoint}/host`,
      workspaceBaseUrl: `${endpoint}/workspace`,
      runnerBaseUrl: `${endpoint}/runner`
    });
    expect(giteaHostCloneUrl(connection, "dim-example", "root")).toBe(`${endpoint}/host/dim-example/root.git`);
    expect(giteaInternalCloneUrl(connection, "dim-example", "root")).toBe(`${endpoint}/workspace/dim-example/root.git`);
    await expect(giteaNestedBaseUrl(runner, connection)).resolves.toBe(`${endpoint}/workspace`);
    await expect(giteaRunnerBaseUrl(runner, connection)).resolves.toBe(`${endpoint}/runner`);
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

  it("rejects a symlinked connection file without following it", async () => {
    // Given
    const endpoint = await authenticatedGiteaEndpoint(servers, "operator", "admin-secret");
    const target = await externalConnectionFile(roots, endpoint);
    const connectionFile = `${target}.link`;
    await symlink(target, connectionFile);
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_GITEA_CONNECTION_FILE: connectionFile
    });

    // When / Then
    await expect(ensureGitea(rejectingDockerRunner(), options)).rejects.toThrow(/regular file/);
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

  it.each([
    ["administrator", { adminIsAdmin: false }, /administrator.*admin/],
    ["writer", { writerIsAdmin: true }, /writer.*non-administrator/],
    ["maintainer", { maintainerIsAdmin: true }, /maintainer.*non-administrator/]
  ])("rejects an invalid %s role", async (_role, roleOverrides, message) => {
    const endpoint = await authenticatedGiteaEndpoint(servers, "operator", "admin-secret", roleOverrides);
    const connectionFile = await externalConnectionFile(roots, endpoint);
    const options = lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer",
      DIM_GITEA_CONNECTION_FILE: connectionFile
    });

    await expect(ensureGitea(rejectingDockerRunner(), options)).rejects.toThrow(message);
  });

  it("allows the host administrator and maintainer to share one privileged identity", async () => {
    // Given
    const endpoint = await authenticatedGiteaEndpoint(servers, "operator", "admin-secret");
    const connectionFile = await externalConnectionFile(roots, endpoint, {
      maintainerUsername: "operator",
      maintainerPassword: "admin-secret"
    });

    // When
    const connection = await ensureGitea(rejectingDockerRunner(), lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer", DIM_GITEA_CONNECTION_FILE: connectionFile
    }));

    // Then
    expect(connection).toMatchObject({
      adminUsername: "operator",
      writerUsername: "workspace-writer",
      maintainerUsername: "operator"
    });
  });

  it("rejects a writer sharing a privileged identity and unsafe Project bindings before transport", async () => {
    const endpoint = await authenticatedGiteaEndpoint(servers, "operator", "admin-secret");
    const duplicate = await externalConnectionFile(roots, endpoint, { writerUsername: "operator" });
    const unsafe = await externalConnectionFile(roots, endpoint, { projectId: "../shared" });

    await expect(ensureGitea(rejectingDockerRunner(), lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer", DIM_GITEA_CONNECTION_FILE: duplicate
    }))).rejects.toThrow(/writer.*distinct/);
    await expect(ensureGitea(rejectingDockerRunner(), lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer", DIM_GITEA_CONNECTION_FILE: unsafe
    }))).rejects.toThrow(/safe identifier/);
  });

  it("requires Project IDs, namespaces, and organization IDs to be unique", async () => {
    // Given
    const endpoint = await authenticatedGiteaEndpoint(servers, "operator", "admin-secret");
    const connectionFile = await externalConnectionFile(roots, endpoint, {
      additionalProject: { id: "shared-project-id", gitNamespace: "dim-other", giteaOrganizationId: 42 }
    });

    // When / Then
    await expect(ensureGitea(rejectingDockerRunner(), lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer", DIM_GITEA_CONNECTION_FILE: connectionFile
    }))).rejects.toThrow(/Project id.*unique/);
  });

  it("rejects HTTP unless the configured transport permits its network boundary", async () => {
    const endpoint = await authenticatedGiteaEndpoint(servers, "operator", "admin-secret");
    const connectionFile = await externalConnectionFile(roots, endpoint, { transport: "https" });

    await expect(ensureGitea(rejectingDockerRunner(), lifecycleOptionsForBackend("sysbox", {
      HOME: "/home/developer", DIM_GITEA_CONNECTION_FILE: connectionFile
    }))).rejects.toThrow(/does not match configured https transport/);
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
  password: string,
  roles: {
    readonly adminIsAdmin?: boolean;
    readonly writerIsAdmin?: boolean;
    readonly maintainerIsAdmin?: boolean;
  } = {}
): Promise<string> {
  const identities = new Map([
    [`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, { login: username, is_admin: roles.adminIsAdmin ?? true }],
    [`Basic ${Buffer.from("workspace-writer:writer-secret").toString("base64")}`, { login: "workspace-writer", is_admin: roles.writerIsAdmin ?? false }],
    [`Basic ${Buffer.from("host-maintainer:maintainer-secret").toString("base64")}`, { login: "host-maintainer", is_admin: roles.maintainerIsAdmin ?? false }]
  ]);
  const server = createServer((request, response) => {
    if (request.url === "/api/v1/version") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: "test" }));
      return;
    }
    const identity = request.headers.authorization === undefined ? undefined : identities.get(request.headers.authorization);
    if (request.url === "/api/v1/user" && identity !== undefined) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(identity));
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
  override: {
    readonly adminPassword?: string;
    readonly hostBaseUrl?: string;
    readonly writerUsername?: string;
    readonly maintainerUsername?: string;
    readonly maintainerPassword?: string;
    readonly projectId?: string;
    readonly transport?: string;
    readonly additionalProject?: Readonly<Record<string, unknown>>;
  } = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dim-external-gitea-"));
  roots.push(root);
  const connectionFile = join(root, "connection.json");
  await writeFile(connectionFile, JSON.stringify({
    schemaVersion: 1,
    transport: override.transport ?? "loopback-http",
    hostId: "host-a",
    apiBaseUrl: `${endpoint}/api/v1`,
    hostBaseUrl: override.hostBaseUrl ?? `${endpoint}/host`,
    workspaceBaseUrl: `${endpoint}/workspace`,
    runnerBaseUrl: `${endpoint}/runner`,
    credentials: {
      adminUsername: "operator",
      adminPassword: override.adminPassword ?? "admin-secret",
      writerUsername: override.writerUsername ?? "workspace-writer",
      writerPassword: "writer-secret",
      maintainerUsername: override.maintainerUsername ?? "host-maintainer",
      maintainerPassword: override.maintainerPassword ?? "maintainer-secret"
    },
    projects: {
      example: {
        id: override.projectId ?? "shared-project-id",
        gitNamespace: "dim-example",
        giteaOrganizationId: 41
      },
      ...(override.additionalProject === undefined ? {} : { other: override.additionalProject })
    }
  }), { mode: 0o600 });
  return connectionFile;
}
