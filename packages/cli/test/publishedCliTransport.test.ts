import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runPublishedCli, type PublishedCliResult } from "./publishedCliFixture.js";

interface SessionRequest {
  readonly operation: string;
  readonly input: Record<string, unknown>;
}

interface WorkspaceCreateScenario {
  readonly repositoryRefs: readonly string[];
  readonly controllerError?: string;
}

interface WorkspaceCreateRun {
  readonly requests: readonly SessionRequest[];
  readonly result: PublishedCliResult;
}

test("published workspace create sends repeated repository refs unchanged and in order", async () => {
  const repositoryRefs = ["api=refs/pull/42/head", "web=feature/candidate"];

  const { requests, result } = await runWorkspaceCreate({ repositoryRefs });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Workspace 'candidate' is ready\n");
  assert.deepEqual(requests, [{
    operation: "workspace.create",
    input: {
      project: "project",
      name: "candidate",
      profiles: [],
      requiredCapabilities: [],
      recommendedCapabilities: [],
      repositoryRefs,
      runtimeBackend: "sysbox",
      cpuCount: "7",
      memory: "9g",
      pidsLimit: "321"
    }
  }]);
});

test("published workspace create leaves repository-ref validation failures to the controller", async (context) => {
  const scenarios = [
    {
      name: "malformed override",
      repositoryRef: "malformed",
      error: "repository ref override 'malformed' must use alias=ref"
    },
    {
      name: "root alias",
      repositoryRef: "root=next",
      error: "the root repository ref cannot be overridden by a workspace candidate"
    },
    {
      name: "unknown alias",
      repositoryRef: "missing=next",
      error: "project 'project' has no repository 'missing'"
    }
  ] as const;

  for (const scenario of scenarios) await context.test(scenario.name, async () => {
    const { requests, result } = await runWorkspaceCreate({
      repositoryRefs: [scenario.repositoryRef],
      controllerError: scenario.error
    });

    assert.equal(result.status, 2);
    assert.equal(result.stderr, `${scenario.error}\nRun 'dim doctor' to check host readiness.\n`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.operation, "workspace.create");
    assert.deepEqual(requests[0]?.input.repositoryRefs, [scenario.repositoryRef]);
  });
});

async function runWorkspaceCreate(scenario: WorkspaceCreateScenario): Promise<WorkspaceCreateRun> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-published-cli-"));
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
  const requests: SessionRequest[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200).end();
      return;
    }
    if (request.method === "POST" && request.url === "/v1/sessions") {
      requests.push(await requestBody(request));
      response.writeHead(202, { "content-type": "application/json" }).end('{"id":"session"}');
      return;
    }
    if (request.method === "GET" && request.url === "/v1/sessions/session/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = scenario.controllerError === undefined
        ? { type: "result", result: { name: "candidate" } }
        : { type: "error", error: scenario.controllerError };
      response.end(`data: ${JSON.stringify(event)}\n\n`);
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    const args = ["workspace", "create", "project", "candidate"];
    for (const repositoryRef of scenario.repositoryRefs) args.push("--repo-ref", repositoryRef);
    const result = await runPublishedCli(args, {
      ...process.env,
      DIM_STATE_ROOT: stateRoot,
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: runtimeRoot,
      DIM_CONTROLLER_SOCKET: socketPath,
      DIM_AGENT_CONTROLLER_SOCKET: socketPath,
      DIM_ADMIN_CONTROLLER_SOCKET: socketPath,
      DIM_WORKSPACE_CPUS: "7",
      DIM_WORKSPACE_MEMORY: "9g",
      DIM_WORKSPACE_PIDS: "321"
    });
    return { requests, result };
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
}

async function requestBody(request: IncomingMessage): Promise<SessionRequest> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body) as SessionRequest;
}
