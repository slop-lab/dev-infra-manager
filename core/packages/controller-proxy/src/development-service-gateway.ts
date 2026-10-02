import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createControlServer } from "./development-service-control.js";
import {
  DEVELOPMENT_SERVICE_GATEWAY_PORT,
  DevelopmentServiceStateError,
  developmentServiceControlSocket,
  type DevelopmentServiceRoute,
  loadRoutes,
  parseAuthority,
  prepareStateDirectory,
  saveRoutes
} from "./development-service-state.js";

export type DevelopmentServiceGatewayOptions = {
  readonly listenPort?: number;
  readonly stateDirectory: string;
};

export type DevelopmentServiceGateway = {
  readonly controlSocket: string;
  listen(): Promise<number>;
  close(): Promise<void>;
  getRoute(name: string): Promise<DevelopmentServiceRoute | undefined>;
  setRoute(route: DevelopmentServiceRoute): Promise<void>;
};

export function createDevelopmentServiceGateway(
  options: DevelopmentServiceGatewayOptions
): DevelopmentServiceGateway {
  const routes = new Map<string, DevelopmentServiceRoute>();
  const sockets = new Set<Socket>();
  let routeUpdates = Promise.resolve();
  const setRoute = (route: DevelopmentServiceRoute): Promise<void> => {
    const update = routeUpdates.then(async () => {
      assertRouteAvailable(routes, route);
      const updated = [...routes.values()].filter(({ name }) => name !== route.name).concat(route);
      await saveRoutes(options.stateDirectory, updated);
      routes.set(route.name, route);
    });
    routeUpdates = update.then(() => undefined, () => undefined);
    return update;
  };
  const controlSocket = developmentServiceControlSocket(options.stateDirectory);
  const gateway = http.createServer((request, response) => {
    void proxyHttp(routes, request, response);
  });
  gateway.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  gateway.on("upgrade", (request, socket, head) => proxyUpgrade(routes, request, socket, head));
  const control = createControlServer(controlSocket, {
    getRoute: async (name) => routes.get(name),
    setRoute
  });
  return {
    controlSocket,
    async listen() {
      await prepareStateDirectory(options.stateDirectory);
      for (const route of await loadRoutes(options.stateDirectory)) {
        assertRouteAvailable(routes, route);
        routes.set(route.name, route);
      }
      await listenTcp(gateway, options.listenPort ?? DEVELOPMENT_SERVICE_GATEWAY_PORT);
      try {
        await control.listen();
      } catch (error) {
        await closeHttpServer(gateway);
        throw error;
      }
      const address = gateway.address();
      if (typeof address !== "object" || address === null) {
        throw new DevelopmentServiceGatewayError("gateway did not bind a TCP address");
      }
      return address.port;
    },
    async close() {
      await control.close();
      for (const socket of sockets) socket.destroy();
      if (gateway.listening) await closeHttpServer(gateway);
    },
    getRoute: async (name) => routes.get(name),
    setRoute
  };
}

async function proxyHttp(
  routes: ReadonlyMap<string, DevelopmentServiceRoute>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const selected = selectRoute(routes, request);
  if (selected.kind === "error") {
    response.writeHead(selected.status).end();
    return;
  }
  const upstream = http.request({
    host: "127.0.0.1",
    port: selected.route.targetPort,
    method: request.method,
    path: request.url,
    headers: forwardedHeaders(request.headers, selected.authority)
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
}

function proxyUpgrade(
  routes: ReadonlyMap<string, DevelopmentServiceRoute>,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const selected = selectRoute(routes, request);
  if (selected.kind === "error") {
    socket.end(`HTTP/1.1 ${selected.status} ${selected.status === 404 ? "Not Found" : "Bad Request"}\r\n\r\n`);
    return;
  }
  const upstream = http.request({
    host: "127.0.0.1",
    port: selected.route.targetPort,
    method: request.method,
    path: request.url,
    headers: upgradeHeaders(request.headers, selected.authority)
  });
  upstream.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const status = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}`;
    const headers = pairs(upstreamResponse.rawHeaders).map(([name, value]) => `${name}: ${value}`);
    socket.write(`${[status, ...headers, "", ""].join("\r\n")}`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.once("response", (upstreamResponse) => {
    socket.end(`HTTP/1.1 ${upstreamResponse.statusCode ?? 502} Bad Gateway\r\nConnection: close\r\n\r\n`);
  });
  upstream.once("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
  upstream.end();
}

type RouteSelection =
  | { readonly kind: "route"; readonly route: DevelopmentServiceRoute; readonly authority: string }
  | { readonly kind: "error"; readonly status: 400 | 404 };

function selectRoute(
  routes: ReadonlyMap<string, DevelopmentServiceRoute>,
  request: IncomingMessage
): RouteSelection {
  const hosts = headerValues(request.rawHeaders, "host");
  const forwardedHosts = headerValues(request.rawHeaders, "x-forwarded-host");
  if (hosts.length !== 1 || forwardedHosts.length > 1) return { kind: "error", status: 400 };
  try {
    const host = parseAuthority(hosts[0] ?? "");
    const forwardedHost = forwardedHosts[0] === undefined ? undefined : parseAuthority(forwardedHosts[0]);
    if (forwardedHost !== undefined && host !== forwardedHost && routeByAuthority(routes, host) !== undefined) {
      return { kind: "error", status: 400 };
    }
    const route = routeByAuthority(routes, forwardedHost ?? host);
    return route === undefined
      ? { kind: "error", status: 404 }
      : { kind: "route", route, authority: forwardedHost ?? host };
  } catch (error) {
    if (error instanceof DevelopmentServiceStateError) return { kind: "error", status: 400 };
    throw error;
  }
}

function forwardedHeaders(headers: IncomingHttpHeaders, authority: string): IncomingHttpHeaders {
  const forwarded = { ...headers };
  for (const name of ["connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade"]) {
    delete forwarded[name];
  }
  forwarded.host = authority;
  forwarded["x-forwarded-host"] = authority;
  return forwarded;
}

function upgradeHeaders(headers: IncomingHttpHeaders, authority: string): IncomingHttpHeaders {
  return {
    ...forwardedHeaders(headers, authority),
    connection: "Upgrade",
    ...(headers.upgrade === undefined ? {} : { upgrade: headers.upgrade })
  };
}

function routeByAuthority(
  routes: ReadonlyMap<string, DevelopmentServiceRoute>,
  authority: string
): DevelopmentServiceRoute | undefined {
  return [...routes.values()].find((route) =>
    route.authority === authority || route.permalinkAuthority === authority);
}

function assertRouteAvailable(
  routes: ReadonlyMap<string, DevelopmentServiceRoute>,
  candidate: DevelopmentServiceRoute
): void {
  const candidateAuthorities = new Set([candidate.authority, candidate.permalinkAuthority]);
  const collision = [...routes.values()].find((route) => route.name !== candidate.name
    && (candidateAuthorities.has(route.authority)
      || candidateAuthorities.has(route.permalinkAuthority)
      || route.urlId === candidate.urlId));
  if (collision !== undefined) {
    throw new DevelopmentServiceGatewayError(`external URL is already assigned to service '${collision.name}'`);
  }
}

function headerValues(rawHeaders: readonly string[], requestedName: string): readonly string[] {
  return pairs(rawHeaders)
    .filter(([name]) => name.toLowerCase() === requestedName)
    .map(([, value]) => value);
}

function pairs(rawHeaders: readonly string[]): ReadonlyArray<readonly [string, string]> {
  const result: Array<readonly [string, string]> = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) result.push([name, value]);
  }
  return result;
}

function listenTcp(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export class DevelopmentServiceGatewayError extends Error {
  readonly name = "DevelopmentServiceGatewayError";
}
