import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAdminStreamProgress,
  streamProgressLabel,
  streamProgressOperations,
  type CliProgress,
  type ProgressScheduler,
  type ProgressStream,
  type ProgressTimer
} from "../../../../core/packages/cli/src/cli-progress.js";
import { readAdminSession } from "../../../../core/packages/cli/src/cli-support.js";
import { readCliSource } from "./sourceArchitecture.js";

class TestTimer implements ProgressTimer {
  cancelled = false;
  unreferenced = false;

  constructor(
    readonly callback: () => void,
    readonly dueAt: number
  ) {}

  unref(): void {
    this.unreferenced = true;
  }

  cancel(): void {
    this.cancelled = true;
  }
}

class TestScheduler implements ProgressScheduler {
  private now = 0;
  readonly timers: TestTimer[] = [];

  setTimeout(callback: () => void, delay: number): TestTimer {
    const timer = new TestTimer(callback, this.now + delay);
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(timer: ProgressTimer): void {
    timer.cancel();
  }

  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const next = this.timers
        .filter((timer) => !timer.cancelled && timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (next === undefined) break;
      next.cancelled = true;
      this.now = next.dueAt;
      next.callback();
    }
    this.now = target;
  }
}

class MemoryStream implements ProgressStream {
  readonly chunks: string[] = [];

  constructor(readonly isTTY: boolean, private readonly prefix = "") {}

  write(chunk: string | Uint8Array): boolean {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    this.chunks.push(`${this.prefix}${text}`);
    return true;
  }
}

class RecordingProgress implements CliProgress {
  activities = 0;
  stops = 0;

  constructor(private readonly entries: string[] = []) {}

  activity(): void {
    this.activities += 1;
    this.entries.push("clear");
  }

  stop(): void {
    this.stops += 1;
    this.entries.push("stop");
  }
}

const timing = { idleDelayMs: 1_000, frameIntervalMs: 100 };

test("idle progress waits for the quiet threshold before rendering TTY frames", () => {
  const scheduler = new TestScheduler();
  const stream = new MemoryStream(true);
  createAdminStreamProgress("workspace.create", {}, { scheduler, stream, ...timing });

  scheduler.advance(999);
  assert.deepEqual(stream.chunks, []);
  scheduler.advance(1);
  assert.match(stream.chunks[0] ?? "", /^\r- Creating workspace/);
  assert.equal(scheduler.timers[0]?.unreferenced, true);
  scheduler.advance(100);
  assert.match(stream.chunks[1] ?? "", /^\r\\ Creating workspace/);
});

test("stream activity clears the active frame before payload and restarts the idle delay", () => {
  const scheduler = new TestScheduler();
  const stream = new MemoryStream(true);
  const progress = createAdminStreamProgress("workspace.setup", {}, { scheduler, stream, ...timing });
  scheduler.advance(1_000);

  progress.activity();
  stream.write(Buffer.from("[setup] prepare\n"));
  scheduler.advance(999);
  assert.deepEqual(stream.chunks.slice(1), ["\r\u001b[K", "[setup] prepare\n"]);
  scheduler.advance(1);
  assert.match(stream.chunks[3] ?? "", /^\r[-\\|/] Setting up workspace/);
});

test("progress stop clears a visible frame and cancels further rendering", () => {
  const scheduler = new TestScheduler();
  const stream = new MemoryStream(true);
  const progress = createAdminStreamProgress("host.start", {}, { scheduler, stream, ...timing });
  scheduler.advance(1_000);

  progress.stop();
  progress.activity();
  scheduler.advance(1_000);

  assert.deepEqual(stream.chunks, ["\r- Starting host runtimes", "\r\u001b[K"]);
  assert.equal(scheduler.timers.length, 2);
});

test("non-TTY and interactive stream options never schedule or emit progress", () => {
  for (const fixture of [
    { operation: "workspace.create", options: {}, tty: false },
    { operation: "workspace.create", options: { stdin: true }, tty: true },
    { operation: "workspace.create", options: { terminal: true }, tty: true },
    { operation: "workspace.exec", options: {}, tty: true },
    { operation: "workspace.run", options: {}, tty: true }
  ]) {
    const scheduler = new TestScheduler();
    const stream = new MemoryStream(fixture.tty);
    createAdminStreamProgress(fixture.operation, fixture.options, { scheduler, stream, ...timing });
    scheduler.advance(5_000);
    assert.equal(scheduler.timers.length, 0);
    assert.deepEqual(stream.chunks, []);
  }
});

test("every lifecycle and CI progress operation has one stable label", () => {
  assert.deepEqual(streamProgressOperations, [
    "workspace.create", "workspace.resources", "workspace.setup", "workspace.update",
    "workspace.start", "workspace.restart", "workspace.stop", "workspace.discard",
    "ci.runner.create", "ci.runner.start", "ci.runner.restart", "ci.runner.stop", "ci.runner.delete",
    "ci.runner.logs", "host.start", "host.shutdown"
  ]);
  for (const operation of streamProgressOperations) assert.equal(typeof streamProgressLabel(operation), "string");
  assert.equal(streamProgressLabel("workspace.align"), undefined);
  assert.equal(streamProgressLabel("workspace.exec"), undefined);
  assert.equal(streamProgressLabel("workspace.run"), undefined);
});

test("TTY progress never contaminates JSON stdout", () => {
  const scheduler = new TestScheduler();
  const stderr = new MemoryStream(true);
  const stdout = new MemoryStream(false);
  const progress = createAdminStreamProgress("ci.runner.create", {}, { scheduler, stream: stderr, ...timing });
  scheduler.advance(1_000);
  progress.stop();
  stdout.write(`${JSON.stringify({ status: "ready" })}\n`);

  assert.deepEqual(JSON.parse(stdout.chunks.join("")), { status: "ready" });
  assert.equal(stdout.chunks.join("").includes("\u001b"), false);
  assert.notEqual(stderr.chunks.length, 0);
});

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
