import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAdminStreamProgress,
  type CliProgress,
  type ProgressScheduler,
  type ProgressStream,
  type ProgressTimer
} from "../../../../core/packages/cli/src/cli-progress.js";
import { readAdminSession } from "../../../../core/packages/cli/src/cli-support.js";

class FakeTimer implements ProgressTimer {
  cancelled = false;
  unreferenced = false;

  constructor(
    readonly callback: () => void,
    readonly dueAt: number
  ) {}

  cancel(): void {
    this.cancelled = true;
  }

  unref(): void {
    this.unreferenced = true;
  }
}

class FakeClock implements ProgressScheduler {
  private now = 0;
  private readonly timers: FakeTimer[] = [];
  maximumActiveTimers = 0;

  setTimeout(callback: () => void, delay: number): FakeTimer {
    const timer = new FakeTimer(callback, this.now + delay);
    this.timers.push(timer);
    this.maximumActiveTimers = Math.max(this.maximumActiveTimers, this.activeTimers);
    return timer;
  }

  clearTimeout(timer: ProgressTimer): void {
    timer.cancel();
  }

  get activeTimers(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
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

class ByteStream implements ProgressStream {
  readonly chunks: Buffer[] = [];
  private readonly waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];

  constructor(readonly isTTY: boolean) {}

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    for (const waiter of this.waiters.splice(0)) {
      if (this.chunks.length >= waiter.count) waiter.resolve();
      else this.waiters.push(waiter);
    }
    return true;
  }

  waitForCount(count: number): Promise<void> {
    if (this.chunks.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface SessionStreams {
  readonly progress: CliProgress;
  readonly stdout: ProgressStream;
  readonly stderr: ProgressStream;
}

interface SessionControl<T> {
  readonly response: ServerResponse;
  readonly result: Promise<T>;
}

test("default TTY progress renders only after five idle seconds", () => {
  const clock = new FakeClock();
  const terminal = new ByteStream(true);
  const progress = createAdminStreamProgress("workspace.create", {}, { scheduler: clock, stream: terminal });

  clock.advance(4_999);
  assert.equal(terminal.chunks.length, 0);
  clock.advance(1);

  assert.match(terminal.bytes().toString(), /^\r- Creating workspace/);
  assert.equal(clock.maximumActiveTimers, 1);
  progress.stop();
  assert.equal(clock.activeTimers, 0);
});

test("each stdout and stderr chunk restarts the full idle delay", async () => {
  const clock = new FakeClock();
  const terminal = new ByteStream(true);
  const stdout = new ByteStream(false);
  const stderr = new ByteStream(false);
  const progress = createAdminStreamProgress(
    "workspace.setup",
    {},
    { scheduler: clock, stream: terminal, idleDelayMs: 5_000, frameIntervalMs: 100 }
  );

  await withSession({ progress, stdout, stderr }, async ({ response, result }) => {
    writeEvent(response, streamEvent("stdout", Buffer.from("first\n")));
    await stdout.waitForCount(1);
    clock.advance(4_999);
    assert.equal(terminal.chunks.length, 0);

    writeEvent(response, streamEvent("stderr", Buffer.from("second\n")));
    await stderr.waitForCount(1);
    clock.advance(4_999);
    assert.equal(terminal.chunks.length, 0);
    clock.advance(1);
    assert.match(terminal.bytes().toString(), /Setting up workspace/);

    writeEvent(response, { type: "result", result: { exitCode: 23 } });
    response.end();
    assert.deepEqual(await result, { exitCode: 23 });
  });

  assert.equal(terminal.chunks.filter((chunk) => chunk.equals(Buffer.from("\r\u001b[K"))).length, 1);
  assert.equal(clock.activeTimers, 0);
  assert.equal(clock.maximumActiveTimers, 1);
});

test("a failed session clears one visible indicator and preserves the error", async () => {
  const clock = new FakeClock();
  const terminal = new ByteStream(true);
  const progress = createAdminStreamProgress(
    "host.start",
    {},
    { scheduler: clock, stream: terminal, idleDelayMs: 5_000, frameIntervalMs: 100 }
  );

  await withSession(
    { progress, stdout: new ByteStream(false), stderr: new ByteStream(false) },
    async ({ response, result }) => {
      clock.advance(5_000);
      writeEvent(response, { type: "error", error: "controller failed unchanged" });
      response.end();
      await assert.rejects(result, /controller failed unchanged/);
    }
  );

  assert.equal(terminal.chunks.filter((chunk) => chunk.equals(Buffer.from("\r\u001b[K"))).length, 1);
  assert.equal(clock.activeTimers, 0);
});

test("non-TTY session output remains byte-identical without terminal bytes", async () => {
  const clock = new FakeClock();
  const stdout = new ByteStream(false);
  const stderr = new ByteStream(false);
  const progress = createAdminStreamProgress("workspace.update", {}, { scheduler: clock, stream: stderr });
  const expectedStdout = Buffer.from([0x00, 0xff, 0x1b, 0x5b, 0x4b, 0x0a]);
  const expectedStderr = Buffer.from([0xfe, 0x0d, 0x0a]);

  await withSession({ progress, stdout, stderr }, async ({ response, result }) => {
    writeEvent(response, streamEvent("stdout", expectedStdout));
    writeEvent(response, streamEvent("stderr", expectedStderr));
    writeEvent(response, { type: "result", result: { ok: true } });
    response.end();
    assert.deepEqual(await result, { ok: true });
  });

  assert.deepEqual(stdout.bytes(), expectedStdout);
  assert.deepEqual(stderr.bytes(), expectedStderr);
  assert.equal(clock.activeTimers, 0);
  assert.equal(clock.maximumActiveTimers, 0);
});

function streamEvent(type: "stdout" | "stderr", data: Buffer): object {
  return { type, data: data.toString("base64"), encoding: "base64" };
}

function writeEvent(response: ServerResponse, event: object): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function withSession<T>(
  streams: SessionStreams,
  action: (control: SessionControl<T>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-cli-progress-timing-"));
  const socketPath = path.join(root, "admin.sock");
  let provideResponse: (response: ServerResponse) => void = () => {};
  const responseReady = new Promise<ServerResponse>((resolve) => {
    provideResponse = resolve;
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    provideResponse(response);
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    const result = readAdminSession<T>(socketPath, "session", streams);
    await action({ response: await responseReady, result });
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
}
