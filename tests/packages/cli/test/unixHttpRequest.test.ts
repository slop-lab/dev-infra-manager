import assert from "node:assert/strict";
import { getEventListeners, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unixHttpRequest } from "../../../../core/packages/cli/src/cli-support.js";

const settlementDeadlineMs = 1_000;

class SettlementTimeoutError extends Error {
  readonly name = "SettlementTimeoutError";

  constructor(readonly scenario: string) {
    super(`${scenario} did not settle within ${settlementDeadlineMs}ms`);
  }
}

test("Unix HTTP requests settle once across every terminal path", async (context) => {
  const uncaughtExceptions: unknown[] = [];
  const unhandledRejections: unknown[] = [];
  const captureUncaught = (error: unknown): void => { uncaughtExceptions.push(error); };
  const captureUnhandled = (error: unknown): void => { unhandledRejections.push(error); };
  process.on("uncaughtException", captureUncaught);
  process.on("unhandledRejection", captureUnhandled);

  try {
    await context.test("rejects when the server aborts after headers", async () => {
      await withHttpServer((response) => {
        response.writeHead(200, { "content-length": "4" });
        response.flushHeaders();
        response.destroy();
      }, async (socketPath) => {
        const controller = new AbortController();
        await assert.rejects(
          settleWithin(
            unixHttpRequest(socketPath, "/headers", { signal: controller.signal }),
            "headers-then-abort"
          ),
          /aborted|socket hang up|ECONNRESET/
        );
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      });
    });

    await context.test("rejects a partial body instead of returning it as success", async () => {
      await withHttpServer((response) => {
        response.writeHead(200, { "content-length": "8" });
        response.write("part", () => response.destroy());
      }, async (socketPath) => {
        await assert.rejects(
          settleWithin(unixHttpRequest(socketPath, "/partial", {}), "partial-body-abort"),
          /aborted|terminated|ECONNRESET/
        );
      });
    });

    await context.test("keeps a late response error inert after a request error settles", async () => {
      await withRawServer((socket) => {
        socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\ninvalid\r\n");
      }, async (socketPath) => {
        await assert.rejects(
          settleWithin(unixHttpRequest(socketPath, "/malformed", {}), "response-error-race"),
          /Parse Error|Invalid character|HPE_INVALID_CHUNK_SIZE/
        );
      });
    });

    await context.test("rejects with the caller abort reason", async () => {
      let requestReceived: () => void = () => {};
      const received = new Promise<void>((resolve) => { requestReceived = resolve; });
      await withHttpServer((_response) => requestReceived(), async (socketPath) => {
        const controller = new AbortController();
        const reason = new Error("caller stopped");
        const pending = unixHttpRequest(socketPath, "/caller-abort", { signal: controller.signal });
        await received;
        controller.abort(reason);
        await assert.rejects(settleWithin(pending, "caller-abort"), reason);
      });
    });

    await context.test("rejects a request transport error", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "dim-unix-http-missing-"));
      try {
        await assert.rejects(
          settleWithin(unixHttpRequest(path.join(root, "missing.sock"), "/missing", {}), "request-error"),
          /ENOENT/
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    await context.test("returns the complete status and body", async () => {
      await withHttpServer((response) => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end('{"created":true}');
      }, async (socketPath) => {
        const controller = new AbortController();
        assert.deepEqual(
          await settleWithin(
            unixHttpRequest(socketPath, "/complete", { signal: controller.signal }),
            "normal-completion"
          ),
          { status: 201, body: '{"created":true}' }
        );
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      });
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(uncaughtExceptions, []);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.removeListener("uncaughtException", captureUncaught);
    process.removeListener("unhandledRejection", captureUnhandled);
  }
});

async function settleWithin<T>(pending: Promise<T>, scenario: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new SettlementTimeoutError(scenario)), settlementDeadlineMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function withHttpServer(
  respond: (response: ServerResponse) => void,
  action: (socketPath: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-unix-http-"));
  const socketPath = path.join(root, "controller.sock");
  const server = createHttpServer((_request, response) => respond(response));
  server.listen(socketPath);
  await once(server, "listening");
  try {
    await action(socketPath);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
}

async function withRawServer(
  respond: (socket: Socket) => void,
  action: (socketPath: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "dim-unix-http-raw-"));
  const socketPath = path.join(root, "controller.sock");
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    respond(socket);
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    await action(socketPath);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
}
