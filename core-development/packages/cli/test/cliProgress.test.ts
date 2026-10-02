import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdminStreamProgress,
  streamProgressLabel,
  streamProgressOperations,
  type ProgressScheduler,
  type ProgressStream,
  type ProgressTimer
} from "../../../../core/packages/cli/src/cli-progress.js";

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

  constructor(
    readonly isTTY: boolean,
    private readonly prefix = "",
    readonly columns?: number
  ) {}

  write(chunk: string | Uint8Array): boolean {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    this.chunks.push(`${this.prefix}${text}`);
    return true;
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
  assert.match(stream.chunks[0] ?? "", /^\r- Current: input validation/);
  assert.equal(scheduler.timers[0]?.unreferenced, true);
  scheduler.advance(100);
  assert.match(stream.chunks[3] ?? "", /^\r\\ Current: input validation/);
});

test("stream activity clears the active frame before payload and restarts the idle delay", () => {
  const scheduler = new TestScheduler();
  const stream = new MemoryStream(true);
  const progress = createAdminStreamProgress("workspace.setup", {}, { scheduler, stream, ...timing });
  scheduler.advance(1_000);

  progress.activity();
  stream.write(Buffer.from("[setup] prepare\n"));
  scheduler.advance(999);
  assert.deepEqual(stream.chunks.slice(1), [
    "\r\u001b[K",
    "\u001b[1A\r\u001b[K",
    "[setup] prepare\n"
  ]);
  scheduler.advance(1);
  assert.match(stream.chunks[4] ?? "", /^\r[-\\|/] Current: input validation/);
});

test("progress stop clears a visible frame and cancels further rendering", () => {
  const scheduler = new TestScheduler();
  const stream = new MemoryStream(true);
  const progress = createAdminStreamProgress("host.start", {}, { scheduler, stream, ...timing });
  scheduler.advance(1_000);

  progress.stop();
  progress.activity();
  scheduler.advance(1_000);

  assert.deepEqual(stream.chunks, ["\r- Current: Starting host runtimes", "\r\u001b[K"]);
  assert.equal(scheduler.timers.length, 2);
});

test("optional lifecycle stages appear only after the controller enters them", () => {
  const scheduler = new TestScheduler();
  const stream = new MemoryStream(true);
  const progress = createAdminStreamProgress("workspace.restart", {}, { scheduler, stream, ...timing });

  scheduler.advance(1_000);
  assert.doesNotMatch(stream.chunks.join(""), /workspace stop/);
  progress.update("workspace stop");
  scheduler.advance(1_000);
  assert.match(stream.chunks.at(-1) ?? "", /Current: workspace stop/);
});

test("unknown controller stages cannot reach terminal progress", () => {
  const scheduler = new TestScheduler();
  const stream = new MemoryStream(true);
  const progress = createAdminStreamProgress("workspace.create", {}, { scheduler, stream, ...timing });

  progress.update("credential=should-not-render");
  scheduler.advance(1_000);

  assert.match(stream.chunks.join(""), /Current: input validation/);
  assert.doesNotMatch(stream.chunks.join(""), /should-not-render/);
});

test("progress rows fit the active terminal width", () => {
  const scheduler = new TestScheduler();
  const stream = new MemoryStream(true, "", 40);
  const progress = createAdminStreamProgress("workspace.restart", {}, { scheduler, stream, ...timing });

  progress.update("workspace reconciliation");
  scheduler.advance(1_000);

  const lines = (stream.chunks.at(-1) ?? "").slice(1).split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines.every((line) => line.length <= 40), true);
  assert.match(lines[1] ?? "", /\.\.\.$/);
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
