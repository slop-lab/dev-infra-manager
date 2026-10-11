import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const cli = path.resolve(
  import.meta.dirname,
  "../../../../core/packages/controller-proxy/dist/development-service-cli.js"
);
const executeFile = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => Promise.all(cleanup.splice(0).reverse().map((item) => item())));

describe("published development service CLI", () => {
  it("accepts a nested URL request without a workspace or socket selector", () => {
    // Given: the built helper without its workspace-scoped controller environment.
    const arguments_ = [
      cli,
      "request-url",
      "--ingress",
      "local-http",
      "--container",
      "dev",
      "--container",
      "deep",
      "--port",
      "5678"
    ];

    // When: a workspace caller requests one nested HTTP service URL.
    const result = spawnSync(process.execPath, arguments_, {
      encoding: "utf8",
      env: {
        ...process.env,
        DIM_CONTROLLER_SOCKET: "",
        DIM_CONTROLLER_TOKEN: "",
        DIM_AGENT_CONTROLLER_SOCKET: "",
        DIM_AGENT_CONTROLLER_TOKEN: ""
      }
    });

    // Then: parsing reaches the environment-derived capability boundary.
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toBe("workspace controller socket and token are required\n");
  });

  it("rejects a partial workspace controller pair instead of falling back", () => {
    // Given: an incomplete workspace pair and a complete agent pair.
    const arguments_ = [
      cli,
      "request-url",
      "--ingress",
      "local-http",
      "--container",
      "dev",
      "--port",
      "8080"
    ];

    // When: the helper selects controller authority.
    const result = spawnSync(process.execPath, arguments_, {
      encoding: "utf8",
      env: {
        ...process.env,
        DIM_CONTROLLER_SOCKET: "/run/dim/controller.sock",
        DIM_CONTROLLER_TOKEN: "",
        DIM_AGENT_CONTROLLER_SOCKET: "/run/dim/agent.sock",
        DIM_AGENT_CONTROLLER_TOKEN: "agent-grant"
      }
    });

    // Then: it refuses to mix or silently downgrade authority pairs.
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toBe("DIM_CONTROLLER_SOCKET and DIM_CONTROLLER_TOKEN must be set together\n");
  });

  it.each([
    {
      name: "dev",
      cliArguments: ["--container", "dev", "--port", "8080"],
      containers: ["dev"],
      port: 8080
    },
    {
      name: "deep",
      cliArguments: ["--container", "dev", "--container", "deep", "--port", "5678"],
      containers: ["dev", "deep"],
      port: 5678
    }
  ])("requests the $name HTTP URL through only the workspace controller", async ({
    name,
    cliArguments,
    containers,
    port
  }) => {
    // Given: a workspace-scoped controller fixture.
    const root = await mkdtemp(path.join(tmpdir(), "dim-development-request-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const socket = path.join(root, "controller.sock");
    let requestBody: unknown;
    let authorization: string | undefined;
    const controller = http.createServer(async (request, response) => {
      authorization = request.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ urls: [{
        id: `url-${name}`,
        url: `http://work--${name}.example.test`,
        approval: "pending"
      }] }));
    });
    await listenSocket(controller, socket);
    cleanup.push(() => closeServer(controller));

    // When: the helper requests the two-level nested target.
    const result = await executeFile(process.execPath, [
      cli, "request-url", "--ingress", "local-http", ...cliArguments
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        DIM_CONTROLLER_SOCKET: socket,
        DIM_CONTROLLER_TOKEN: "workspace-grant",
        DIM_AGENT_CONTROLLER_SOCKET: "",
        DIM_AGENT_CONTROLLER_TOKEN: ""
      }
    });

    // Then: it emits the controller record and cannot add authority selectors to the request.
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ urls: [{
      id: `url-${name}`,
      url: `http://work--${name}.example.test`,
      approval: "pending"
    }] });
    expect(requestBody).toEqual({
      ingress: "local-http",
      target: { containers, protocol: "http", port }
    });
    expect(authorization).toBe("Bearer workspace-grant");
  });

  it.each(["--workspace", "--subdomain", "--socket", "--admin-socket"])(
    "rejects the foreign-scope selector %s",
    (selector) => {
      // Given: a request containing a selector outside the workspace-derived contract.
      const arguments_ = [
        cli,
        "request-url",
        "--ingress",
        "local-http",
        "--container",
        "dev",
        "--port",
        "8080",
        selector,
        "foreign"
      ];

      // When: the helper parses the request.
      const result = spawnSync(process.execPath, arguments_, { encoding: "utf8" });

      // Then: it rejects the selector before contacting any socket.
      expect(result).toMatchObject({ status: 1, stdout: "" });
      expect(result.stderr).toBe(`unknown option '${selector}'\n`);
    }
  );

  it("rejects a target deeper than the controller contract", () => {
    // Given: a request containing three nested container names.
    const arguments_ = [
      cli,
      "request-url",
      "--ingress",
      "local-http",
      "--container",
      "dev",
      "--container",
      "deep",
      "--container",
      "foreign",
      "--port",
      "5678"
    ];

    // When: the helper parses the target.
    const result = spawnSync(process.execPath, arguments_, { encoding: "utf8" });

    // Then: it rejects the unsafe depth before reading controller authority.
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toBe("request-url accepts at most two --container options\n");
  });

  it("rejects caller-selected target protocols", () => {
    // Given: a request attempting to turn the helper into a raw TCP capability.
    const arguments_ = [
      cli,
      "request-url",
      "--ingress",
      "local-http",
      "--container",
      "dev",
      "--port",
      "8080",
      "--protocol",
      "tcp"
    ];

    // When: the helper parses the target.
    const result = spawnSync(process.execPath, arguments_, { encoding: "utf8" });

    // Then: it rejects protocol selection before reading controller authority.
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toBe("unknown option '--protocol'\n");
  });

  it("rejects a service name with a trailing hyphen", () => {
    // Given: the built CLI and a service name that would end its DNS label with a hyphen.
    const arguments_ = [cli, "workspace-subdomain", "--workspace", "work", "--service", "preview-"];

    // When: the published command generates a workspace service subdomain.
    const result = spawnSync(process.execPath, arguments_, { encoding: "utf8" });

    // Then: it fails without emitting a label.
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toBe("service name must be a lowercase DNS label\n");
  });

  it("emits a valid OpenCode workspace service label", () => {
    // Given: the built CLI and the reviewed OpenCode service name.
    const arguments_ = [cli, "workspace-subdomain", "--workspace", "work", "--service", "opencode"];

    // When: the published command generates a workspace service subdomain.
    const result = spawnSync(process.execPath, arguments_, { encoding: "utf8" });

    // Then: the command succeeds with one DNS-safe label.
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout.trim()).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    expect(result.stdout).toMatch(/--opencode\n$/);
  });
});

function listenSocket(server: http.Server, socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
