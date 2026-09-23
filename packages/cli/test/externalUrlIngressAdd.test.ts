import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runPublishedCli } from "./publishedCliFixture.js";

type AdminRequest = {
  readonly path: string;
  readonly body: unknown;
};

type AdminFixture = {
  readonly environment: NodeJS.ProcessEnv;
  readonly requests: AdminRequest[];
  close(): Promise<void>;
};

test("published ingress add help includes raw TCP", async () => {
  const result = await runPublishedCli(
    ["external-url", "ingress", "add", "tailscale", "--help"],
    process.env
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--scheme <scheme>\s+http, https, or tcp/);
});

test("published ingress add dispatches TCP driver arguments to host admin", async () => {
  const fixture = await createAdminFixture();
  try {
    const result = await runPublishedCli(ingressArgs("tcp"), fixture.environment);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /fixture captured ingress-add/);
    assert.deepEqual(fixture.requests, [{
      path: "/v1/external-url/ingress-add",
      body: {
        driver: "tailscale",
        name: "tailnet-ssh",
        description: "Tailnet SSH",
        scheme: "tcp",
        arguments: ["--listen-port", "49152"]
      }
    }]);
  } finally {
    await fixture.close();
  }
});

test("published ingress add rejects an unsupported scheme before host admin", async () => {
  const fixture = await createAdminFixture();
  try {
    const result = await runPublishedCli(ingressArgs("udp"), fixture.environment);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--scheme must be http, https, or tcp/);
    assert.deepEqual(fixture.requests, []);
  } finally {
    await fixture.close();
  }
});

async function createAdminFixture(): Promise<AdminFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-external-url-ingress-"));
  const stateRoot = path.join(root, "state");
  const runtimeRoot = path.join(root, "runtime");
  const configHome = path.join(root, "config");
  const socketPath = path.join(root, "admin.sock");
  const runtimeDirectory = path.join(
    runtimeRoot,
    "dim",
    createHash("sha256").update(stateRoot).digest("hex").slice(0, 16)
  );
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(path.join(configHome, "dim", "config.json"), '{"schemaVersion":1,"workspaceBackend":"sysbox"}\n');
  await writeFile(path.join(runtimeDirectory, "controller.pid"), `${process.pid}\n`);
  const requests: AdminRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200).end();
      return;
    }
    if (request.method === "POST" && request.url === "/v1/external-url/ingress-add") {
      requests.push({ path: request.url, body: await requestBody(request) });
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"fixture captured ingress-add"}');
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(socketPath);
  await once(server, "listening");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DIM_STATE_ROOT: stateRoot,
    XDG_CONFIG_HOME: configHome,
    XDG_RUNTIME_DIR: runtimeRoot,
    DIM_CONTROLLER_SOCKET: socketPath,
    DIM_AGENT_CONTROLLER_SOCKET: socketPath,
    DIM_ADMIN_CONTROLLER_SOCKET: socketPath
  };
  return {
    environment,
    requests,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      await rm(root, { recursive: true, force: true });
    }
  };
}

function ingressArgs(scheme: string): readonly string[] {
  return [
    "external-url", "ingress", "add", "tailscale",
    "--name", "tailnet-ssh",
    "--description", "Tailnet SSH",
    "--scheme", scheme,
    "--listen-port", "49152"
  ];
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body) as unknown;
}
