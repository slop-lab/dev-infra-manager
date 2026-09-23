import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { lifecycleOptions } from "../../../../core/packages/core/src/index.js";
import { revokeWorkspaceExternalUrls } from "../../../../core/packages/cli/src/workspace-lifecycle-commands.js";

const cli = fileURLToPath(new URL("../../../../core/packages/cli/src/cli.ts", import.meta.url));

test("discard cleanup skips only an absent workspace controller grant", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-discard-external-urls-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, "state");
  const configPath = path.join(root, "config.json");
  await writeFile(configPath, `${JSON.stringify({ schemaVersion: 1, workspaceBackend: "sysbox" })}\n`);
  const original = {
    config: process.env.DIM_CONFIG_PATH,
    socket: process.env.DIM_CONTROLLER_SOCKET,
    stateRoot: process.env.DIM_STATE_ROOT
  };
  process.env.DIM_CONFIG_PATH = configPath;
  process.env.DIM_STATE_ROOT = stateRoot;
  context.after(() => {
    restoreEnvironment("DIM_CONFIG_PATH", original.config);
    restoreEnvironment("DIM_CONTROLLER_SOCKET", original.socket);
    restoreEnvironment("DIM_STATE_ROOT", original.stateRoot);
  });

  await context.test("missing grant is optional", async () => {
    process.env.DIM_CONTROLLER_SOCKET = path.join(root, "unused.sock");
    await assert.doesNotReject(revokeWorkspaceExternalUrls("work-1"));
  });

  await mkdir(path.join(stateRoot, "workspace-grants"), { recursive: true });
  await writeFile(path.join(stateRoot, "workspace-grants", "work-1"), "grant\n");

  await context.test("unavailable optional route remains skippable", async () => {
    const socketPath = path.join(root, "not-found.sock");
    const server = createServer((_request, response) => response.writeHead(404).end());
    server.listen(socketPath);
    await once(server, "listening");
    context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    process.env.DIM_CONTROLLER_SOCKET = socketPath;

    await assert.doesNotReject(revokeWorkspaceExternalUrls("work-1"));
  });

  await context.test("authorization failure remains fatal", async () => {
    const socketPath = path.join(root, "forbidden.sock");
    const server = createServer((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"error":"forbidden"}');
    });
    server.listen(socketPath);
    await once(server, "listening");
    context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    process.env.DIM_CONTROLLER_SOCKET = socketPath;

    await assert.rejects(revokeWorkspaceExternalUrls("work-1"), /controller request failed \(403\)/);
  });

  await context.test("transport failure remains fatal", async () => {
    process.env.DIM_CONTROLLER_SOCKET = path.join(root, "missing.sock");
    await assert.rejects(revokeWorkspaceExternalUrls("work-1"), /ENOENT|connect/);
  });

  await context.test("CLI continues to the discard session when the grant is absent", async () => {
    await rm(path.join(stateRoot, "workspace-grants", "work-1"));
    delete process.env.DIM_CONTROLLER_SOCKET;
    const options = lifecycleOptions();
    const operations: string[] = [];
    const healthHandler = (_request: IncomingMessage, response: ServerResponse) => response.writeHead(200).end();
    const workspaceController = createServer(healthHandler);
    const agentController = createServer(healthHandler);
    const adminController = createServer(async (request, response) => {
      if (request.url === "/healthz") {
        response.writeHead(200).end();
        return;
      }
      if (request.method === "POST" && request.url === "/v1/sessions") {
        const body = await readRequestJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || !("operation" in body)) {
          response.writeHead(400).end();
          return;
        }
        operations.push(String(body.operation));
        response.writeHead(202, { "content-type": "application/json" });
        response.end('{"id":"discard-session"}');
        return;
      }
      if (request.method === "GET" && request.url === "/v1/sessions/discard-session/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end('data: {"type":"result","result":{}}\n\n');
        return;
      }
      if (request.method === "POST" && request.url === "/v1/call/workspace.list") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('[{"name":"remaining"}]');
        return;
      }
      response.writeHead(404).end();
    });
    await Promise.all([
      listenUnix(workspaceController, options.controllerSocketPath),
      listenUnix(agentController, options.agentControllerSocketPath),
      listenUnix(adminController, options.adminControllerSocketPath)
    ]);
    context.after(() => Promise.all([
      closeServer(workspaceController),
      closeServer(agentController),
      closeServer(adminController)
    ]).then(() => {}));
    await mkdir(options.controllerRuntimeDirectory, { recursive: true });
    await writeFile(path.join(options.controllerRuntimeDirectory, "controller.pid"), `${process.pid}\n`);

    const result = await runCli(["workspace", "discard", "work-1", "--yes"]);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(operations, ["workspace.discard"]);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function listenUnix(server: ReturnType<typeof createServer>, socketPath: string): Promise<void> {
  return mkdir(path.dirname(socketPath), { recursive: true }).then(() => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  }));
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function runCli(arguments_: readonly string[]): Promise<{ readonly code: number | null; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...arguments_], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}
