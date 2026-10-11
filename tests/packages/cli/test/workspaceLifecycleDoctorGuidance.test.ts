import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runPublishedCli, type PublishedCliResult } from "./publishedCliFixture.js";

const doctorGuidance = "Run 'dim doctor' to check host readiness.";

interface SessionRequest {
  readonly operation: string;
  readonly input: Record<string, unknown>;
}

interface CommandRun {
  readonly requests: readonly SessionRequest[];
  readonly result: PublishedCliResult;
}

test("host-sensitive workspace lifecycle session failures recommend doctor", async (context) => {
  const scenarios = [
    { operation: "workspace.create", args: ["workspace", "create", "project", "candidate", "--no-kvm", "--json"] },
    { operation: "workspace.setup", args: ["workspace", "setup", "candidate", "--json"] },
    { operation: "workspace.update", args: ["workspace", "update", "candidate", "--json"] },
    { operation: "workspace.start", args: ["workspace", "start", "candidate", "--json"] },
    { operation: "workspace.restart", args: ["workspace", "restart", "candidate", "--json"] }
  ] as const;

  for (const scenario of scenarios) await context.test(scenario.operation, async () => {
    const { requests, result } = await runCommand(scenario.args, `${scenario.operation} failed`);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`${scenario.operation.replace(".", "\\.")} failed`));
    assert.equal(guidanceOccurrences(result.stderr), 1);
    assert.deepEqual(requests.map(({ operation }) => operation), [scenario.operation]);
  });
});

test("workspace lifecycle guidance is not duplicated when controller context already includes it", async () => {
  const { result } = await runCommand(
    ["workspace", "setup", "candidate"],
    `setup failed\n${doctorGuidance}`
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /setup failed/);
  assert.equal(guidanceOccurrences(result.stderr), 1);
});

test("workspace lifecycle guidance preserves stage context and the original failure", async () => {
  const { result } = await runCommand(
    ["workspace", "setup", "candidate"],
    "workspace setup at Project setup: project setup exited with 17"
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /workspace setup at Project setup/);
  assert.match(result.stderr, /project setup exited with 17/);
  assert.equal(guidanceOccurrences(result.stderr), 1);
});

test("unrelated workspace controller-session failures do not recommend doctor", async (context) => {
  const scenarios = [
    { operation: "workspace.run", args: ["workspace", "run", "candidate", "task"] },
    { operation: "workspace.exec", args: ["workspace", "exec", "candidate", "true"] },
    { operation: "workspace.stop", args: ["workspace", "stop", "candidate"] },
    { operation: "workspace.discard", args: ["workspace", "discard", "candidate", "--yes"] },
    { operation: "workspace.resources", args: ["workspace", "resources", "candidate", "--cpus", "2"] }
  ] as const;

  for (const scenario of scenarios) await context.test(scenario.operation, async () => {
    const { requests, result } = await runCommand(scenario.args, `${scenario.operation} failed`);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`${scenario.operation.replace(".", "\\.")} failed`));
    assert.equal(guidanceOccurrences(result.stderr), 0);
    assert.deepEqual(requests.map(({ operation }) => operation), [scenario.operation]);
  });
});

test("local workspace option validation does not recommend doctor or start a session", async (context) => {
  const scenarios = [
    ["workspace", "update", "candidate", "--profile", "dev", "--clear-profiles"],
    ["workspace", "resources", "candidate"],
    ["workspace", "discard", "candidate"]
  ] as const;

  for (const args of scenarios) await context.test(args.join(" "), async () => {
    const { requests, result } = await runCommand(args, "unused controller error");

    assert.equal(result.status, 2);
    assert.equal(guidanceOccurrences(result.stderr), 0);
    assert.deepEqual(requests, []);
  });
});

test("obsolete workspace align is rejected locally without doctor guidance or a session", async () => {
  const { requests, result } = await runCommand(
    ["workspace", "align", "candidate", "--reset"],
    "unused controller error"
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command 'align'/);
  assert.equal(guidanceOccurrences(result.stderr), 0);
  assert.deepEqual(requests, []);
});

function guidanceOccurrences(value: string): number {
  return value.split(doctorGuidance).length - 1;
}

async function runCommand(args: readonly string[], controllerError: string): Promise<CommandRun> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-workspace-lifecycle-guidance-"));
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
      response.end(`data: ${JSON.stringify({ type: "error", error: controllerError })}\n\n`);
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
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
