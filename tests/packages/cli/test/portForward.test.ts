import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { forwardWorkspace } from "../../../../core/packages/cli/src/port-forward.js";

const peer = fileURLToPath(new URL("./fixtures/host-peer.mjs", import.meta.url));

test("forwarding preserves concurrent binary exchanges and refuses a reused workspace name", async () => {
  await withForward(async (fixture) => {
    const input = Buffer.alloc(256 * 1024 + 1);
    for (let index = 0; index < input.length; index++) input[index] = index % 256;
    const results = await Promise.all([exchange(fixture.port, input), exchange(fixture.port, Buffer.from("second request"))]);
    assert.deepEqual(results, [input, Buffer.from("second request")]);
    assert.equal(fixture.accepted(), 2);
    await writeFile(fixture.state, JSON.stringify({ id: "replacement", runtimeStatus: "running" }));
    assert.equal((await exchange(fixture.port, Buffer.from("do not deliver to replacement"))).length, 0);
    assert.equal(fixture.accepted(), 2);
    assert.match(fixture.diagnostics(), /was replaced; restart forwarding/);
  });
});

test("cancellation closes the listener, client sockets and active host connections", async () => {
  await withForward(async (fixture) => {
    const client = createConnection({ host: "127.0.0.1", port: fixture.port });
    client.on("error", () => {});
    await once(client, "connect");
    client.write("keep this connection open");
    await fixture.waitForTarget();
    const closed = once(client, "close");
    const targetClosed = fixture.waitForTargetsClosed();
    fixture.abort.abort();
    await fixture.done;
    await closed;
    await targetClosed;
    assert.equal(fixture.active(), 0);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const connection = createConnection({ host: "127.0.0.1", port: fixture.port });
      connection.once("connect", () => { connection.destroy(); resolve(); });
      connection.once("error", reject);
    }), /ECONNREFUSED/);
  });
});

interface Fixture {
  port: number;
  state: string;
  abort: AbortController;
  done: Promise<void>;
  accepted(): number;
  active(): number;
  waitForTarget(): Promise<void>;
  waitForTargetsClosed(): Promise<void>;
  diagnostics(): string;
}

async function withForward(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "dim-port-forward-"));
  const state = path.join(directory, "workspace.json");
  await writeFile(state, JSON.stringify({ id: "original", runtimeStatus: "running" }));
  const sockets = new Set<Socket>();
  let accepted = 0;
  const target = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket); accepted++;
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    const input: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => input.push(chunk));
    socket.on("end", () => socket.end(Buffer.concat(input)));
  });
  target.listen(0, "127.0.0.1"); await once(target, "listening");
  const address = target.address();
  assert.ok(address && typeof address === "object");
  const abort = new AbortController();
  let diagnostic = "";
  const stderr = new Writable({ write(chunk, _encoding, callback) { diagnostic += String(chunk); callback(); } });
  let ready: (port: number) => void = () => {};
  const listening = new Promise<number>((resolve) => { ready = resolve; });
  const done = forwardWorkspace({ name: "local" }, "dev", 0, address.port, {
    localCommand: { file: process.execPath, args: [peer, "--state", state] },
    signal: abort.signal, stderr, onListening: ready
  });
  try {
    const port = await Promise.race([listening, done.then(() => { throw new Error("forward ended before listening"); })]);
    await action({
      port, state, abort, done,
      accepted: () => accepted, active: () => sockets.size,
      waitForTarget: async () => { if (sockets.size === 0) await once(target, "connection"); },
      waitForTargetsClosed: async () => { await Promise.all([...sockets].map((socket) => once(socket, "close"))); },
      diagnostics: () => diagnostic
    });
  } finally {
    abort.abort();
    try { await done; }
    finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => target.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function exchange(port: number, input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const output: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => output.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(output)));
    socket.once("connect", () => socket.end(input));
  });
}
