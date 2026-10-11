import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";

export const webhookAuthorization = `Basic ${Buffer.from(
  "native-events:webhook-secret-000000000000000000000"
).toString("base64")}`;

export type CentralMode = "cacheable" | "correct" | "hang" | "lose-first-response" | "redirect" | "wrong-id";

export type CentralFixture = {
  mode: CentralMode;
  readonly server: Server;
  readonly requests: readonly RequestRecord[];
  readonly demands: ReadonlySet<string>;
  listen(port: number): Promise<void>;
  waitForRequestCount(count: number): Promise<void>;
};

type RequestRecord = {
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
};

export function createCentralFixture(): CentralFixture {
  const requests: RequestRecord[] = [];
  const demands = new Set<string>();
  const waiters = new Map<number, () => void>();
  const attempts = new Map<string, number>();
  const state: { mode: CentralMode } = { mode: "correct" };
  const server = createServer((request, response) => void handle(request, response));
  return {
    get mode() { return state.mode; },
    set mode(mode) { state.mode = mode; },
    server,
    requests,
    demands,
    async listen(port) {
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
    },
    waitForRequestCount(count) {
      if (requests.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.set(count, resolve));
    }
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    requests.push({
      authorization: request.headers.authorization,
      contentType: request.headers["content-type"],
      body
    });
    resolveWaiters(waiters, requests.length);
    if (state.mode === "hang") return;
    const event: unknown = JSON.parse(body);
    const eventId = typeof event === "object" && event !== null ? Reflect.get(event, "eventId") : undefined;
    if (typeof eventId !== "string") throw new Error("expected event ID");
    demands.add(eventId);
    const attempt = (attempts.get(eventId) ?? 0) + 1;
    attempts.set(eventId, attempt);
    if (state.mode === "lose-first-response" && demands.size === 1 && attempt === 1) {
      request.socket.destroy();
      return;
    }
    const acceptedEventId = state.mode === "wrong-id" || (state.mode === "lose-first-response" && demands.size === 2)
      ? "00000000-0000-4000-8000-000000000000"
      : eventId;
    const status = state.mode === "redirect" ? 307 : 202;
    const cacheControl = state.mode === "cacheable" ? "public, max-age=60" : "no-store";
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": cacheControl });
    response.end(JSON.stringify({ schemaVersion: 1, eventId: acceptedEventId, accepted: true }));
  }
}

export type AckLossProxy = {
  readonly server: Server;
  readonly bodies: readonly string[];
  readonly upstreamResponses: readonly string[];
  listen(port: number): Promise<void>;
  waitForRequestCount(count: number): Promise<void>;
  waitForResponseCount(count: number): Promise<void>;
};

export function createAckLossProxy(target: string): AckLossProxy {
  const bodies: string[] = [];
  const upstreamResponses: string[] = [];
  const waiters = new Map<number, () => void>();
  const responseWaiters = new Map<number, () => void>();
  let loseResponse = true;
  const server = createServer((request, response) => void forward(request, response));
  return {
    server,
    bodies,
    upstreamResponses,
    async listen(port) {
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
    },
    waitForRequestCount(count) {
      if (bodies.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.set(count, resolve));
    },
    waitForResponseCount(count) {
      if (upstreamResponses.length >= count) return Promise.resolve();
      return new Promise((resolve) => responseWaiters.set(count, resolve));
    }
  };

  async function forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    bodies.push(body);
    resolveWaiters(waiters, bodies.length);
    const upstream = await fetch(`${target}/v1/native-events`, {
      method: "POST",
      headers: {
        Authorization: request.headers.authorization ?? "",
        "Content-Type": request.headers["content-type"] ?? ""
      },
      body
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    upstreamResponses.push(`${upstream.status} ${bytes.toString("utf8")}`);
    resolveWaiters(responseWaiters, upstreamResponses.length);
    if (loseResponse) {
      loseResponse = false;
      request.socket.destroy();
      return;
    }
    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "",
      "Cache-Control": upstream.headers.get("cache-control") ?? ""
    });
    response.end(bytes);
  }
}

export async function reservePort(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP listener");
  const port = address.port;
  await closeServer(server);
  return port;
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

export function authorityDatabaseCounts(file: string): Readonly<Record<string, number>> {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      inbox: sqliteCount(database, "native_event_inbox"),
      demands: sqliteCount(database, "demands"),
      eventFences: sqliteCount(database, "native_event_replay_fences"),
      reviewJobFences: sqliteCount(database, "review_job_replay_fences")
    };
  } finally {
    database.close();
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function resolveWaiters(waiters: Map<number, () => void>, count: number): void {
  for (const [expected, resolve] of waiters) {
    if (count >= expected) {
      waiters.delete(expected);
      resolve();
    }
  }
}

function sqliteCount(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get();
  if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("expected SQLite row");
  const total = Reflect.get(row, "total");
  if (typeof total !== "number") throw new Error("expected SQLite count");
  return total;
}
