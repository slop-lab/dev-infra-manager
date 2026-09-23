import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adminStreamCall } from "../../../../core/packages/cli/src/cli-support.js";

type InputPayload = {
  readonly data?: string;
  readonly end?: boolean;
  readonly resize?: { readonly columns: number; readonly rows: number };
};

interface ControllerBehavior {
  readonly input?: (payload: InputPayload, response: ServerResponse) => void;
  readonly cancel?: (response: ServerResponse) => void;
}

interface ControllerControl {
  readonly events: Promise<ServerResponse>;
  readonly inputs: InputPayload[];
  readonly waitForInputs: (count: number) => Promise<void>;
}

test("non-2xx data, end, and resize responses reject the stream call and restore listeners", async (context) => {
  const fixtures: ReadonlyArray<{
    readonly name: string;
    readonly options: { readonly stdin?: boolean; readonly terminal?: boolean };
    readonly trigger: () => void;
  }> = [
    { name: "data", options: { stdin: true }, trigger: () => process.stdin.emit("data", Buffer.from("one")) },
    { name: "end", options: { stdin: true }, trigger: () => process.stdin.emit("end") },
    { name: "resize", options: { terminal: true }, trigger: () => process.emit("SIGWINCH") }
  ];

  for (const fixture of fixtures) await context.test(fixture.name, async () => {
    const listeners = listenerCounts();
    await withController({
      input(_payload, response) {
        response.writeHead(503).end(JSON.stringify({ error: `${fixture.name} refused` }));
      }
    }, async ({ events, waitForInputs }) => {
      const call = adminStreamCall("workspace.exec", {}, fixture.options);
      const eventResponse = await events;
      fixture.trigger();
      await waitForInputs(1);
      writeEvent(eventResponse, { type: "result", result: { exitCode: 0 } });
      eventResponse.end();
      await assert.rejects(call, new RegExp(`${fixture.name} refused`));
    });
    assert.deepEqual(listenerCounts(), listeners);
  });
});

test("input transport failure propagates once without accepting later input or leaking raw mode", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  const rawStates: boolean[] = [];
  const restoreTerminal = fakeTerminal(rawStates);
  const listeners = listenerCounts();
  try {
    await withController({
      input(_payload, response) { response.destroy(); }
    }, async ({ events, inputs }) => {
      const call = adminStreamCall("workspace.exec", {}, { stdin: true, terminal: true });
      const eventResponse = await events;
      process.stdin.emit("data", Buffer.from("first"));
      process.stdin.emit("data", Buffer.from("later"));
      await assert.rejects(call, /socket hang up|aborted/);
      process.stdin.emit("data", Buffer.from("ignored"));
      process.emit("SIGWINCH");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(inputs.length, 1);
      eventResponse.destroy();
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(rawStates, [true, false]);
    assert.deepEqual(listenerCounts(), listeners);
  } finally {
    restoreTerminal();
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("ordered input drains before a successful session result settles", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await withController({
    input(_payload, response) {
      void firstReleased.then(() => response.writeHead(204).end());
    }
  }, async ({ events, inputs }) => {
    let settled = false;
    const call = adminStreamCall<{ exitCode: number }>("workspace.exec", {}, { stdin: true, terminal: true })
      .finally(() => { settled = true; });
    const eventResponse = await events;
    process.stdin.emit("data", Buffer.from("first"));
    process.stdin.emit("data", Buffer.from("second"));
    process.stdin.emit("end");
    process.emit("SIGWINCH");
    writeEvent(eventResponse, { type: "result", result: { exitCode: 0 } });
    eventResponse.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    releaseFirst?.();
    assert.deepEqual(await call, { exitCode: 0 });
    assert.deepEqual(inputs.map(inputKind), ["first", "second", "end", "resize"]);
  });
});

test("an earlier session error is not masked by cancellation of pending input", async () => {
  await withController({ input() {} }, async ({ events, waitForInputs }) => {
    const call = adminStreamCall("workspace.exec", {}, { stdin: true });
    const eventResponse = await events;
    process.stdin.emit("data", Buffer.from("pending"));
    await waitForInputs(1);
    writeEvent(eventResponse, { type: "error", error: "controller failed first" });
    eventResponse.end();
    await assert.rejects(call, /controller failed first/);
  });
});

test("a rejected cancellation request settles the stream call and restores listeners", async () => {
  const listeners = listenerCounts();
  const signalListeners = process.listeners("SIGINT");
  await withController({
    cancel(response) { response.writeHead(502).end(JSON.stringify({ error: "cancel refused" })); }
  }, async ({ events }) => {
    const call = adminStreamCall("workspace.exec");
    const eventResponse = await events;
    const signalHandler = process.listeners("SIGINT").find((listener) => !signalListeners.includes(listener));
    assert.ok(signalHandler);
    signalHandler("SIGINT");
    await assert.rejects(call, /cancel refused/);
    eventResponse.destroy();
  });
  assert.deepEqual(listenerCounts(), listeners);
});

function listenerCounts(): { readonly data: number; readonly end: number; readonly resize: number; readonly sigint: number } {
  return {
    data: process.stdin.listenerCount("data"),
    end: process.stdin.listenerCount("end"),
    resize: process.listenerCount("SIGWINCH"),
    sigint: process.listenerCount("SIGINT")
  };
}

function inputKind(payload: InputPayload): string {
  if (payload.resize) return "resize";
  if (payload.end) return "end";
  return Buffer.from(payload.data ?? "", "base64").toString("utf8");
}

function writeEvent(response: ServerResponse, event: object): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function fakeTerminal(states: boolean[]): () => void {
  const stdin = process.stdin;
  const properties = ["isTTY", "isRaw", "setRawMode"] as const;
  const descriptors = properties.map((property) => Object.getOwnPropertyDescriptor(stdin, property));
  Object.defineProperty(stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(stdin, "isRaw", { configurable: true, value: false, writable: true });
  Object.defineProperty(stdin, "setRawMode", {
    configurable: true,
    value(enabled: boolean) {
      states.push(enabled);
      Object.defineProperty(stdin, "isRaw", { configurable: true, value: enabled, writable: true });
    }
  });
  return () => properties.forEach((property, index) => {
    const descriptor = descriptors[index];
    if (descriptor) Object.defineProperty(stdin, property, descriptor);
    else Reflect.deleteProperty(stdin, property);
  });
}

async function requestBody(request: IncomingMessage): Promise<InputPayload> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body) as InputPayload;
}

async function withController(
  behavior: ControllerBehavior,
  action: (control: ControllerControl) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-cli-input-"));
  const stateRoot = path.join(root, "state");
  const runtimeRoot = path.join(root, "runtime");
  const configHome = path.join(root, "config");
  const socketPath = path.join(root, "controller.sock");
  const runtimeDirectory = path.join(runtimeRoot, "dim", createHash("sha256").update(stateRoot).digest("hex").slice(0, 16));
  await mkdir(path.join(configHome, "dim"), { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(path.join(configHome, "dim", "config.json"), '{"schemaVersion":1,"workspaceBackend":"sysbox"}\n');
  await writeFile(path.join(runtimeDirectory, "controller.pid"), `${process.pid}\n`);
  const inputs: InputPayload[] = [];
  const inputWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  let provideEvents: (response: ServerResponse) => void = () => {};
  const eventsReady = new Promise<ServerResponse>((resolve) => { provideEvents = resolve; });
  const server = createServer(async (request, response) => {
    if (request.url === "/healthz") return void response.writeHead(200).end();
    if (request.method === "POST" && request.url === "/v1/sessions") {
      return void response.writeHead(202).end('{"id":"session"}');
    }
    if (request.method === "GET" && request.url === "/v1/sessions/session/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      provideEvents(response);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/sessions/session/input") {
      const payload = await requestBody(request);
      inputs.push(payload);
      for (const waiter of inputWaiters.splice(0)) {
        if (inputs.length >= waiter.count) waiter.resolve();
        else inputWaiters.push(waiter);
      }
      if (behavior.input) behavior.input(payload, response);
      else response.writeHead(204).end();
      return;
    }
    if (request.method === "DELETE" && request.url === "/v1/sessions/session") {
      if (behavior.cancel) behavior.cancel(response);
      else response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  const environment = { ...process.env };
  Object.assign(process.env, {
    DIM_STATE_ROOT: stateRoot,
    XDG_CONFIG_HOME: configHome,
    XDG_RUNTIME_DIR: runtimeRoot,
    DIM_CONTROLLER_SOCKET: socketPath,
    DIM_AGENT_CONTROLLER_SOCKET: socketPath,
    DIM_ADMIN_CONTROLLER_SOCKET: socketPath
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    const waitForInputs = (count: number): Promise<void> => {
      if (inputs.length >= count) return Promise.resolve();
      return new Promise((resolve) => inputWaiters.push({ count, resolve }));
    };
    const call = action({ events: eventsReady, inputs, waitForInputs });
    await call;
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    process.env = environment;
    await rm(root, { recursive: true, force: true });
  }
}
