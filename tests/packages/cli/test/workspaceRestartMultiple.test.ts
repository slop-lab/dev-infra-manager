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
  readonly input: { readonly name?: unknown };
}

interface RestartRun {
  readonly requests: readonly SessionRequest[];
  readonly result: PublishedCliResult;
}

test("workspace restart processes multiple targets sequentially", async () => {
  const { requests, result } = await runRestart(["first", "second"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Restarted workspace 'first'\nRestarted workspace 'second'\n");
  assert.deepEqual(requests, [
    { operation: "workspace.restart", input: { name: "first" } },
    { operation: "workspace.restart", input: { name: "second" } }
  ]);
});

test("workspace restart preserves completed output and stops at the failing target", async () => {
  const { requests, result } = await runRestart(["first", "second", "third"], "second");

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "Restarted workspace 'first'\n");
  assert.equal(
    result.stderr,
    "Failed to restart workspace 'second': controller rejected restart\nRun 'dim doctor' to check host readiness.\n"
  );
  assert.deepEqual(requests, [
    { operation: "workspace.restart", input: { name: "first" } },
    { operation: "workspace.restart", input: { name: "second" } }
  ]);
});

test("workspace restart failure does not emit a partial JSON array", async () => {
  const { requests, result } = await runRestart(["first", "second", "third"], "second", true);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Failed to restart workspace 'second': controller rejected restart\nRun 'dim doctor' to check host readiness.\n"
  );
  assert.deepEqual(requests, [
    { operation: "workspace.restart", input: { name: "first" } },
    { operation: "workspace.restart", input: { name: "second" } }
  ]);
});

test("workspace restart emits one JSON array for multiple targets", async () => {
  const { result } = await runRestart(["first", "second"], undefined, true);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ name: "first" }, { name: "second" }]);
});

async function runRestart(
  names: readonly string[],
  failingName?: string,
  json = false
): Promise<RestartRun> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-workspace-restart-multiple-"));
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
  const sessions = new Map<string, string>();
  const server = createServer(async (request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200).end();
      return;
    }
    if (request.method === "POST" && request.url === "/v1/sessions") {
      const body = await requestBody(request);
      requests.push(body);
      const id = `session-${requests.length}`;
      sessions.set(id, String(body.input.name));
      response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ id }));
      return;
    }
    const match = request.url?.match(/^\/v1\/sessions\/(session-[0-9]+)\/events$/);
    if (request.method === "GET" && match?.[1]) {
      const name = sessions.get(match[1]);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = name === failingName
        ? { type: "error", error: "controller rejected restart" }
        : { type: "result", result: { name } };
      response.end(`data: ${JSON.stringify(event)}\n\n`);
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    const args = ["workspace", "restart", ...names, ...(json ? ["--json"] : [])];
    const result = await runPublishedCli(args, {
      ...process.env,
      DIM_STATE_ROOT: stateRoot,
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: runtimeRoot,
      DIM_CONTROLLER_SOCKET: socketPath,
      DIM_AGENT_CONTROLLER_SOCKET: socketPath,
      DIM_ADMIN_CONTROLLER_SOCKET: socketPath
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
