import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { giteaChangePasswordArgs, giteaNestedBaseUrl, giteaRequest, giteaWebhookConfigArgs, type GiteaConnection } from "../src/gitea.js";
import { giteaHookIdsForUrl } from "../src/giteaCiCoordinator.js";
import type { CommandRunner } from "../src/types.js";

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

    await expect(giteaNestedBaseUrl(runner)).resolves.toBe("http://172.20.0.4:3000");
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
      adminUsername: "admin",
      adminPassword: "password",
      writerUsername: "writer",
      writerPassword: "password",
      maintainerUsername: "host",
      maintainerPassword: "password",
      apiBaseUrl: `http://127.0.0.1:${address.port}/api/v1`
    };

    await expect(giteaRequest(connection, "GET", "/version")).resolves.toMatchObject({ status: 200 });
    expect(connection.maintainerUsername).not.toBe(connection.writerUsername);
  });

  it("applies exact webhook targets through Gitea's environment-to-INI contract", () => {
    const args = giteaWebhookConfigArgs([
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
    expect(giteaChangePasswordArgs("dim-host", "secret")).toEqual(expect.arrayContaining([
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
});
