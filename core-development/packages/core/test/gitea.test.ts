import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { giteaChangePasswordArgs, giteaNestedBaseUrl, giteaRequest, giteaWebhookConfigArgs, type GiteaConnection } from "../../../../core/packages/core/src/gitea.js";
import { giteaHookIdsForUrl, uniqueGiteaRunnerId } from "../../../../core/packages/core/src/giteaCiCoordinator.js";
import type { CommandRunner } from "../../../../core/packages/core/src/types.js";

describe("Gitea control endpoint", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("resolves the managed container address from Docker", async () => {
    const runner: CommandRunner = {
      async run(command, args) {
        return { command, args, stdout: "172.20.0.4\n", stderr: "", exitCode: 0 };
      }
    };

    await expect(giteaNestedBaseUrl(runner, {
      kind: "managed",
      endpointAddress: "172.20.0.4",
      adminUsername: "admin",
      adminPassword: "password",
      writerUsername: "writer",
      writerPassword: "password",
      maintainerUsername: "host",
      maintainerPassword: "password",
      apiBaseUrl: "http://127.0.0.1:3300/api/v1",
      hostBaseUrl: "http://127.0.0.1:3300",
      workspaceBaseUrl: "http://dim-gitea:3000",
      runnerBaseUrl: "http://dim-gitea:3000"
    })).resolves.toBe("http://172.20.0.4:3000");
  });

  it("retains the leased managed endpoint when Docker reports address drift", async () => {
    // Given
    const runner: CommandRunner = {
      async run(command, args) {
        return { command, args, stdout: "172.20.0.99\n", stderr: "", exitCode: 0 };
      }
    };
    const connection = {
      kind: "managed" as const,
      endpointAddress: "172.20.0.4",
      adminUsername: "admin",
      adminPassword: "password",
      writerUsername: "writer",
      writerPassword: "password",
      maintainerUsername: "host",
      maintainerPassword: "password",
      apiBaseUrl: "http://127.0.0.1:3300/api/v1",
      hostBaseUrl: "http://127.0.0.1:3300",
      workspaceBaseUrl: "http://dim-gitea:3000",
      runnerBaseUrl: "http://dim-gitea:3000"
    };

    // When
    const nestedBaseUrl = await giteaNestedBaseUrl(runner, connection);

    // Then
    expect(nestedBaseUrl).toBe("http://172.20.0.4:3000");
  });

  it("sends management API requests to the resolved control endpoint", async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.url === "/api/v1/version" ? 200 : 404).end();
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const connection: GiteaConnection = {
      kind: "managed",
      endpointAddress: "172.20.0.4",
      adminUsername: "admin",
      adminPassword: "password",
      writerUsername: "writer",
      writerPassword: "password",
      maintainerUsername: "host",
      maintainerPassword: "password",
      apiBaseUrl: `http://127.0.0.1:${address.port}/api/v1`,
      hostBaseUrl: `http://127.0.0.1:${address.port}`,
      workspaceBaseUrl: "http://dim-gitea:3000",
      runnerBaseUrl: "http://dim-gitea:3000"
    };

    await expect(giteaRequest(connection, "GET", "/version")).resolves.toMatchObject({ status: 200 });
    expect(connection.maintainerUsername).not.toBe(connection.writerUsername);
  });

  it("rejects management API redirects instead of forwarding credentials", async () => {
    const target = createServer((_request, response) => response.writeHead(200).end());
    servers.push(target);
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") throw new Error("missing target address");
    const source = createServer((_request, response) => {
      response.writeHead(302, { Location: `http://127.0.0.1:${targetAddress.port}/stolen` }).end();
    });
    servers.push(source);
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    const sourceAddress = source.address();
    if (!sourceAddress || typeof sourceAddress === "string") throw new Error("missing source address");

    await expect(giteaRequest({
      kind: "managed",
      endpointAddress: "172.20.0.4",
      adminUsername: "admin", adminPassword: "password",
      writerUsername: "writer", writerPassword: "password",
      maintainerUsername: "host", maintainerPassword: "password",
      apiBaseUrl: `http://127.0.0.1:${sourceAddress.port}/api/v1`,
      hostBaseUrl: "http://127.0.0.1", workspaceBaseUrl: "http://dim-gitea:3000", runnerBaseUrl: "http://dim-gitea:3000"
    }, "POST", "/hook", { authorization_header: "Bearer secret" })).rejects.toThrow(/redirect/);
  });

  it("rejects management API paths outside the configured base", async () => {
    const connection: GiteaConnection = {
      kind: "managed",
      endpointAddress: "172.20.0.4",
      adminUsername: "admin", adminPassword: "password",
      writerUsername: "writer", writerPassword: "password",
      maintainerUsername: "host", maintainerPassword: "password",
      apiBaseUrl: "https://gitea.example/api/v1",
      hostBaseUrl: "https://gitea.example",
      workspaceBaseUrl: "http://dim-gitea:3000",
      runnerBaseUrl: "http://dim-gitea:3000"
    };

    await expect(giteaRequest(connection, "POST", "//attacker.invalid/hook", {
      authorization_header: "Bearer secret"
    })).rejects.toThrow(/configured API base URL/);
  });

  it("applies exact webhook targets through Gitea's environment-to-INI contract", () => {
    const args = giteaWebhookConfigArgs("gitea-container-id", [
      "dim-ci-example-qemu-supervisor",
      "dim-ci-example-qemu-supervisor",
      "dim-ci-other-qemu-supervisor"
    ]);
    expect(args).toContain(
      "GITEA__webhook__ALLOWED_HOST_LIST=external,dim-ci-example-qemu-supervisor,dim-ci-other-qemu-supervisor"
    );
    expect(args).toEqual(expect.arrayContaining(["--apply-env", "--in-place"]));
    expect(args).not.toEqual(expect.arrayContaining(["--section", "--key", "--value"]));
  });

  it("recovers managed users without requiring an interactive password change", () => {
    expect(giteaChangePasswordArgs("gitea-container-id", "dim-host", "secret")).toEqual(expect.arrayContaining([
      "--username", "dim-host",
      "--password", "secret",
      "--must-change-password=false"
    ]));
  });

  it("identifies every duplicate webhook by its exact target URL", () => {
    const target = "http://dim-ci-example-qemu-supervisor:8080/workflow-job";
    expect(giteaHookIdsForUrl([
      { id: 1, config: { url: target } },
      { id: 2, config: { url: "http://other:8080/workflow-job" } },
      { id: 3, config: { url: target } },
      { id: 4 }
    ], target)).toEqual([1, 3]);
  });

  it("rejects duplicate provider runner identities before remote deletion", () => {
    expect(() => uniqueGiteaRunnerId([
      { id: 1, name: "shared" },
      { id: 2, name: "shared" }
    ], "shared")).toThrow(/multiple CI coordinator runners/);
  });
});
