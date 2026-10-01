import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LifecycleState } from "../../../../core/packages/core/src/lifecycleState.js";
import { workspaceRecord } from "../../core/test/hostLifecycleFixture.js";
import { runPublishedCli } from "./publishedCliFixture.js";

const allUrls = {
  urls: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      project: "alpha",
      workspace: "work-a",
      ingress: "public",
      target: { containers: ["dev"], port: 3000, protocol: "http" },
      url: "https://work-a--0.example.test/",
      createdAt: "2026-10-01T00:00:00.000Z"
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      project: "beta",
      workspace: "work-b",
      ingress: "public",
      target: { containers: [], port: 8080, protocol: "http" },
      url: "https://work-b--0.example.test/",
      createdAt: "2026-10-01T00:00:01.000Z"
    }
  ]
} as const;

test("published host list uses the admin route and prints every workspace as JSON", async (context) => {
  const fixture = await createHostFixture((request, response) => {
    if (request.method === "POST" && request.url === "/v1/external-url/url-list") {
      response.writeHead(200, { "content-type": "application/json" }).end(`${JSON.stringify(allUrls)}\n`);
      return;
    }
    response.writeHead(404).end();
  });
  context.after(fixture.close);

  const result = await runPublishedCli(["external-url", "list", "--json"], fixture.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${JSON.stringify(allUrls, null, 2)}\n`);
});

test("published list with --workspace remains scoped to that workspace grant", async (context) => {
  const fixture = await createHostFixture((request, response) => {
    if (request.method === "GET" && request.url === "/api/urls") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"urls":[{"workspace":"work-a"}]}\n');
      return;
    }
    response.writeHead(404).end();
  });
  context.after(fixture.close);
  const state = new LifecycleState(fixture.stateRoot);
  const record = workspaceRecord("work-a", "ready");
  await state.claimWorkspace(record);
  const grant = await state.ensureWorkspaceGrant(record.name);
  fixture.environment.DIM_CONTROLLER_SOCKET = fixture.socketPath;

  const result = await runPublishedCli(
    ["external-url", "list", "--workspace", "work-a", "--json"],
    fixture.environment
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{\n  "urls": [\n    {\n      "workspace": "work-a"\n    }\n  ]\n}\n');
  assert.equal(fixture.authorization(), `Bearer ${grant}`);
  assert.deepEqual(fixture.requests(), ["GET /api/urls"]);
});

test("published host list reports a missing External URLs plugin", async (context) => {
  const fixture = await createHostFixture((_request, response) => response.writeHead(404).end());
  context.after(fixture.close);

  const result = await runPublishedCli(["external-url", "list"], fixture.environment);

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /External URL commands require the @slop-lab\/dim-plugin-external-urls plugin; install it and restart the controller/
  );
});

type HostFixture = {
  readonly environment: NodeJS.ProcessEnv;
  readonly stateRoot: string;
  readonly socketPath: string;
  authorization(): string | undefined;
  requests(): readonly string[];
  close(): Promise<void>;
};

async function createHostFixture(
  handler: Parameters<typeof createServer>[0]
): Promise<HostFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-external-url-list-"));
  const stateRoot = path.join(root, "state");
  const runtimeRoot = path.join(root, "runtime");
  const configHome = path.join(root, "config");
  const socketPath = path.join(root, "controller.sock");
  const runtimeDirectory = path.join(
    runtimeRoot,
    "dim",
    createHash("sha256").update(stateRoot).digest("hex").slice(0, 16)
  );
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(path.join(configHome, "dim", "config.json"), '{"schemaVersion":1,"workspaceBackend":"sysbox"}\n');
  await writeFile(path.join(runtimeDirectory, "controller.pid"), `${process.pid}\n`);
  let authorization: string | undefined;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200).end();
      return;
    }
    authorization = request.headers.authorization;
    requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
    request.resume();
    handler?.(request, response);
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
  for (const name of [
    "DIM_CONTROLLER_API",
    "DIM_CONTROLLER_TOKEN",
    "DIM_AGENT_CONTROLLER_TOKEN"
  ]) delete environment[name];
  return {
    environment,
    stateRoot,
    socketPath,
    authorization: () => authorization,
    requests: () => requests,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      await rm(root, { recursive: true, force: true });
    }
  };
}
