import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

export interface ControllerProxyRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Buffer;
}

export interface ControllerProxyResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface ControllerProxyUpstream {
  request(method: string, requestPath: string, body?: Buffer): Promise<ControllerProxyResponse>;
}

export interface ControllerProxyCapability {
  authorize(request: ControllerProxyRequest, upstream: ControllerProxyUpstream): boolean | Promise<boolean>;
  filterResponse?(
    request: ControllerProxyRequest,
    response: ControllerProxyResponse
  ): ControllerProxyResponse | Promise<ControllerProxyResponse>;
}

export interface ControllerProxyOptions {
  readonly listen: string;
  readonly capabilities: readonly ControllerProxyCapability[];
  readonly sourceSocket?: string;
  readonly token?: string;
  readonly maxBodyBytes?: number;
  readonly directoryMode?: number;
  readonly socketMode?: number;
}

export interface ControllerProxy {
  readonly socketPath: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentControllerRoutePolicy {
  readonly method: string;
  readonly path: string;
  readonly maxBodyBytes?: number;
}

export interface AgentControllerProxyOptions extends Omit<ControllerProxyOptions, "capabilities"> {
  readonly routes: readonly AgentControllerRoutePolicy[];
}

// Creates a deny-by-default proxy for the common case where an agent needs a
// small set of exact workspace-controller routes. Discovery is reduced to the
// same allowlist and never exposes host-input providers.
export function createAgentControllerProxy(options: AgentControllerProxyOptions): ControllerProxy {
  return createControllerProxy({
    ...options,
    capabilities: [agentControllerPolicy(options.routes)]
  });
}

export function agentControllerPolicy(
  routes: readonly AgentControllerRoutePolicy[]
): ControllerProxyCapability {
  if (routes.length === 0) throw new Error("agent controller proxy requires at least one allowed route");
  const allowed = routes.map((route) => {
    const method = route.method.toUpperCase();
    if (!method || !route.path.startsWith("/api/")) {
      throw new Error("agent controller routes require a method and an /api/ path");
    }
    const maxBodyBytes = route.maxBodyBytes ?? 0;
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
      throw new Error("agent controller route maxBodyBytes must be a non-negative integer");
    }
    return { method, path: route.path, maxBodyBytes };
  });
  return {
    authorize(request) {
      if (request.method === "GET" && request.path === "/api" && request.body.length === 0) return true;
      return allowed.some((route) => route.method === request.method
        && route.path === request.path
        && request.body.length <= route.maxBodyBytes);
    },
    filterResponse(request, response) {
      if (request.method !== "GET" || request.path !== "/api" || response.status !== 200) return response;
      const body = jsonObject(response.body);
      const discovered = Array.isArray(body.routes)
        ? body.routes.filter((candidate) => isObject(candidate)
          && typeof candidate.method === "string"
          && typeof candidate.path === "string"
          && allowed.some((route) => route.method === candidate.method && route.path === candidate.path))
        : [];
      return {
        status: response.status,
        headers: { ...response.headers, "content-type": "application/json; charset=utf-8" },
        body: Buffer.from(`${JSON.stringify({ ...body, routes: discovered, hostInputProviders: [] })}\n`)
      };
    }
  };
}

export function createControllerProxy(options: ControllerProxyOptions): ControllerProxy {
  const sourceSocket = options.sourceSocket ?? process.env.DIM_CONTROLLER_SOCKET;
  const token = options.token ?? process.env.DIM_CONTROLLER_TOKEN;
  if (!sourceSocket) throw new Error("DIM_CONTROLLER_SOCKET or sourceSocket is required");
  if (!token) throw new Error("DIM_CONTROLLER_TOKEN or token is required");
  if (options.capabilities.length === 0) throw new Error("at least one controller proxy capability is required");
  const listen = path.resolve(options.listen);
  const maxBodyBytes = options.maxBodyBytes ?? 65_536;
  const upstream: ControllerProxyUpstream = {
    request: (method, requestPath, body = Buffer.alloc(0)) =>
      upstreamRequest(sourceSocket, token, method, requestPath, body, maxBodyBytes)
  };
  const server = http.createServer((request, response) => {
    void handle(options.capabilities, upstream, maxBodyBytes, request, response).catch((error) => {
      send(response, 500, Buffer.from(`${JSON.stringify({
        error: error instanceof Error ? error.message : String(error)
      })}\n`), { "content-type": "application/json; charset=utf-8" });
    });
  });

  return {
    socketPath: listen,
    async listen() {
      await mkdir(path.dirname(listen), { recursive: true, mode: options.directoryMode ?? 0o700 });
      await chmod(path.dirname(listen), options.directoryMode ?? 0o700);
      await removeStaleSocket(listen);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(listen, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await chmod(listen, options.socketMode ?? 0o660);
    },
    async close() {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => error ? reject(error) : resolve()));
      }
      await rm(listen, { force: true });
    }
  };
}

async function handle(
  capabilities: readonly ControllerProxyCapability[],
  upstream: ControllerProxyUpstream,
  maxBodyBytes: number,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://dim-controller");
  const body = await readBody(request, maxBodyBytes);
  const input = { method, path: url.pathname, body };
  const capability = await firstAllowed(capabilities, input, upstream);
  if (!capability) {
    send(response, 403, Buffer.from('{"error":"controller proxy policy denied the request"}\n'), {
      "content-type": "application/json; charset=utf-8"
    });
    return;
  }
  let result = await upstream.request(method, url.pathname, body);
  if (capability.filterResponse) result = await capability.filterResponse(input, result);
  send(response, result.status, result.body, result.headers);
}

async function firstAllowed(
  capabilities: readonly ControllerProxyCapability[],
  request: ControllerProxyRequest,
  upstream: ControllerProxyUpstream
): Promise<ControllerProxyCapability | undefined> {
  for (const capability of capabilities) {
    if (await capability.authorize(request, upstream)) return capability;
  }
  return undefined;
}

async function upstreamRequest(
  socketPath: string,
  token: string,
  method: string,
  requestPath: string,
  body: Buffer,
  maxBytes: number
): Promise<ControllerProxyResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method,
      path: requestPath,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body.length === 0 ? {} : {
          "content-type": "application/json",
          "content-length": String(body.length)
        })
      }
    }, async (response) => {
      try {
        resolve({
          status: response.statusCode ?? 500,
          headers: response.headers,
          body: await readBody(response, maxBytes)
        });
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
    if (body.length > 0) request.write(body);
    request.end();
  });
}

async function readBody(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += value.length;
    if (size > maxBytes) throw new Error(`controller proxy body exceeds ${maxBytes} bytes`);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function send(
  response: ServerResponse,
  status: number,
  body: Buffer,
  headers: http.IncomingHttpHeaders
): void {
  const forwarded: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !["connection", "content-length", "transfer-encoding"].includes(name)) {
      forwarded[name] = value;
    }
  }
  response.writeHead(status, { ...forwarded, "content-length": String(body.length) });
  response.end(body);
}

async function removeStaleSocket(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (!stat.isSocket()) throw new Error(`controller proxy listen path exists and is not a socket: ${target}`);
    await rm(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function jsonObject(body: Buffer): Record<string, unknown> {
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    if (isObject(value)) return value;
  } catch {}
  throw new Error("controller proxy expected a JSON object");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
