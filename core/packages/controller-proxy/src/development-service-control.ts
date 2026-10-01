import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, lstat, rm } from "node:fs/promises";
import type { DevelopmentServiceRoute } from "./development-service-state.js";
import { isDevelopmentServiceRoute } from "./development-service-state.js";

const MAX_CONTROL_BODY_BYTES = 16_384;

export type DevelopmentServiceControl = {
  getRoute(name: string): Promise<DevelopmentServiceRoute | undefined>;
  setRoute(route: DevelopmentServiceRoute): Promise<void>;
};

export function createControlServer(
  socketPath: string,
  control: DevelopmentServiceControl
): { readonly server: Server; listen(): Promise<void>; close(): Promise<void> } {
  const server = http.createServer((request, response) => {
    void handleControlRequest(control, request, response).catch((error) => {
      respond(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  return {
    server,
    async listen() {
      await removeStaleSocket(socketPath);
      await listen(server, socketPath);
      await chmod(socketPath, 0o600);
    },
    async close() {
      if (server.listening) await closeServer(server);
      await rm(socketPath, { force: true });
    }
  };
}

export async function getControlledRoute(
  socketPath: string,
  name: string
): Promise<DevelopmentServiceRoute | undefined> {
  const response = await controlRequest(socketPath, "GET", `/services/${encodeURIComponent(name)}`);
  if (response.status === 404) return undefined;
  if (response.status !== 200 || !isDevelopmentServiceRoute(response.body)) {
    throw new DevelopmentServiceControlError(`gateway route lookup failed (${response.status})`);
  }
  return response.body;
}

export async function setControlledRoute(socketPath: string, route: DevelopmentServiceRoute): Promise<void> {
  const response = await controlRequest(
    socketPath,
    "PUT",
    `/services/${encodeURIComponent(route.name)}`,
    route
  );
  if (response.status !== 204) {
    throw new DevelopmentServiceControlError(`gateway route update failed (${response.status})`);
  }
}

export async function gatewayIsReady(socketPath: string): Promise<boolean> {
  try {
    return (await controlRequest(socketPath, "GET", "/health")).status === 204;
  } catch (error) {
    if (isConnectionError(error)) return false;
    throw error;
  }
}

async function handleControlRequest(
  control: DevelopmentServiceControl,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const method = request.method ?? "GET";
  const pathname = new URL(request.url ?? "/", "http://gateway-control").pathname;
  if (method === "GET" && pathname === "/health") {
    response.writeHead(204).end();
    return;
  }
  const match = pathname.match(/^\/services\/([^/]+)$/);
  if (!match) {
    respond(response, 404, { error: "not found" });
    return;
  }
  const name = decodeURIComponent(match[1] ?? "");
  if (method === "GET") {
    const route = await control.getRoute(name);
    if (route === undefined) respond(response, 404, { error: "service not found" });
    else respond(response, 200, route);
    return;
  }
  if (method !== "PUT") {
    respond(response, 405, { error: "method not allowed" });
    return;
  }
  const body = await readJson(request);
  if (!isDevelopmentServiceRoute(body) || body.name !== name) {
    respond(response, 400, { error: "invalid service route" });
    return;
  }
  await control.setRoute(body);
  response.writeHead(204).end();
}

async function controlRequest(
  socketPath: string,
  method: string,
  requestPath: string,
  body?: DevelopmentServiceRoute
): Promise<{ readonly status: number; readonly body: unknown }> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method,
      path: requestPath,
      headers: encoded === undefined ? {} : {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(encoded))
      },
      signal: AbortSignal.timeout(2_000)
    }, async (response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const parsed: unknown = text ? JSON.parse(text) : undefined;
      resolve({ status: response.statusCode ?? 500, body: parsed });
    });
    request.once("error", reject);
    if (encoded !== undefined) request.write(encoded);
    request.end();
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_CONTROL_BODY_BYTES) throw new DevelopmentServiceControlError("gateway control body is too large");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, { "content-type": "application/json", "content-length": encoded.length });
  response.end(encoded);
}

async function removeStaleSocket(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (!stat.isSocket()) throw new DevelopmentServiceControlError(`gateway control path is not a socket: ${target}`);
    await rm(target);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isConnectionError(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && ["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(String(error.code));
}

export class DevelopmentServiceControlError extends Error {
  readonly name = "DevelopmentServiceControlError";
}
