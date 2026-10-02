import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CliProgress, ProgressStream } from "../../../../core/packages/cli/src/cli-progress.js";
import { readAdminSession } from "../../../../core/packages/cli/src/cli-support.js";
import { readCliSource } from "./sourceArchitecture.js";

class RecordingProgress implements CliProgress {
  activities = 0;
  stops = 0;
  updates: string[] = [];

  constructor(private readonly entries: string[] = []) {}

  activity(): void {
    this.activities += 1;
    this.entries.push("clear");
  }

  update(stage: string): void {
    this.updates.push(stage);
    this.entries.push(`stage:${stage}`);
  }

  stop(): void {
    this.stops += 1;
    this.entries.push("stop");
  }
}

test("session stream activity precedes stdout and stderr payloads and result stops progress", async () => {
  const entries: string[] = [];
  const progress = new RecordingProgress(entries);
  const stdout: ProgressStream = {
    isTTY: false,
    write(chunk) { entries.push(`stdout:${String(chunk)}`); return true; }
  };
  const stderr: ProgressStream = {
    isTTY: false,
    write(chunk) { entries.push(`stderr:${String(chunk)}`); return true; }
  };
  const result = await withSessionServer((response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeEvent(response, { type: "stdout", data: Buffer.from("out").toString("base64"), encoding: "base64" });
    writeEvent(response, { type: "stderr", data: Buffer.from("err").toString("base64"), encoding: "base64" });
    writeEvent(response, { type: "result", result: { ok: true } });
    response.end();
  }, (socketPath) => readAdminSession<{ ok: boolean }>(socketPath, "session", { progress, stdout, stderr }));

  assert.deepEqual(entries, ["clear", "stdout:out", "clear", "stderr:err", "stop"]);
  assert.deepEqual(result, { ok: true });
});

test("session progress events update status without writing payload bytes", async () => {
  const entries: string[] = [];
  const progress = new RecordingProgress(entries);
  const result = await withSessionServer((response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeEvent(response, { type: "progress", stage: "Project setup" });
    writeEvent(response, { type: "result", result: { ok: true } });
    response.end();
  }, (socketPath) => readAdminSession<{ ok: boolean }>(socketPath, "session", { progress }));

  assert.deepEqual(entries, ["stage:Project setup", "stop"]);
  assert.deepEqual(result, { ok: true });
});

test("all session response settle paths stop progress", async (context) => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly expected: RegExp;
    readonly respond: (response: ServerResponse) => void;
  }> = [
    { name: "session error", expected: /failed safely/, respond: (response) => {
      response.writeHead(200); writeEvent(response, { type: "error", error: "failed safely" }); response.end();
    } },
    { name: "response error", expected: /request denied/, respond: (response) => {
      response.writeHead(503); response.end('{"error":"request denied"}');
    } },
    { name: "end without result", expected: /ended without a result/, respond: (response) => {
      response.writeHead(200); response.end();
    } },
    { name: "disconnect", expected: /disconnected|socket hang up/, respond: (response) => {
      response.writeHead(200); response.flushHeaders(); response.destroy();
    } },
    { name: "parse error", expected: /JSON/, respond: (response) => {
      response.writeHead(200); response.end("data: {broken\n\n");
    } },
    { name: "encoding error", expected: /invalid stream encoding/, respond: (response) => {
      response.writeHead(200); writeEvent(response, { type: "stdout", data: "text", encoding: "utf8" }); response.end();
    } }
  ];

  for (const fixture of cases) await context.test(fixture.name, async () => {
    const progress = new RecordingProgress();
    await assert.rejects(
      withSessionServer(fixture.respond, (socketPath) => readAdminSession(socketPath, "session", { progress })),
      fixture.expected
    );
    assert.equal(progress.stops, 1);
  });
});

test("session request errors stop progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dim-cli-progress-missing-"));
  const progress = new RecordingProgress();
  try {
    await assert.rejects(readAdminSession(path.join(root, "missing.sock"), "session", { progress }));
    assert.equal(progress.stops, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("top-level and nested exec/run calls retain raw stream options and SIGINT clears progress", async () => {
  const cli = await readCliSource("workspace-execution-commands");
  const support = await readCliSource("controller-session");
  const rawCalls = cli.match(
    /adminStreamCall<[^>]+>\("workspace\.(?:exec|run)",[\s\S]{0,220}\{ stdin: true, terminal: interactive\(\) \}\)/g
  );

  assert.equal(rawCalls?.length, 4);
  assert.match(support, /const requestCancellation = \(\): Promise<void> => \{[\s\S]{0,400}method: "DELETE"[\s\S]*const cancel = \(\) => \{\s+progress\.stop\(\);\s+void requestCancellation\(\)/);
  assert.match(support, /process\.once\("SIGINT", cancel\)/);
});

function writeEvent(response: ServerResponse, event: object): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function withSessionServer<T>(
  respond: (response: ServerResponse) => void,
  action: (socketPath: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-cli-progress-"));
  const socketPath = path.join(root, "admin.sock");
  const server = createServer((_request, response) => respond(response));
  server.listen(socketPath);
  await once(server, "listening");
  try {
    return await action(socketPath);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
}
