import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { UserError } from "@slop-lab/dim-host-core";
import { availableTcpPort, parseIngressCliArguments } from "./ingressDriver.js";
import type { ExternalUrlIngressDriver } from "./plugin-api.js";
import type { ExternalRoute } from "./routeStore.js";

interface Connection { endpoint: string; hostId: string; token: string; domain: string }
interface Argument { connectionFile: string; listenHost: string; listenPort: number | "auto"; publicPort?: number }

/** The only network destination comes from an operator-owned connection file. */
export const controlPlaneIngressDriver: ExternalUrlIngressDriver = {
  async configure(scheme, arguments_) {
    if (scheme === "tcp") throw new UserError("control-plane ingress supports HTTP and HTTPS");
    const argument = parseArgument(JSON.stringify(parseIngressCliArguments("control-plane", arguments_, new Set(["connection-file", "listen-host", "listen-port", "public-port"]))));
    await identity(await readConnection(argument.connectionFile));
    return JSON.stringify({ ...argument, listenPort: argument.listenPort === "auto" ? await availableTcpPort(argument.listenHost) : argument.listenPort });
  },
  async verify(argument) { await identity(await readConnection(parseArgument(argument).connectionFile)); },
  async runtime(argument, _context, scheme) {
    if (scheme === "tcp") throw new UserError("control-plane ingress supports HTTP and HTTPS");
    const parsed = parseArgument(argument);
    if (parsed.listenPort === "auto") throw new UserError("control-plane ingress requires a resolved listen port; re-add it using the CLI");
    const connection = await readConnection(parsed.connectionFile);
    const routes = new Map<string, ExternalRoute>();
    let tail: Promise<unknown> = Promise.resolve();
    const mutate = <T>(operation: () => Promise<T>): Promise<T> => { const result = tail.then(operation, operation); tail = result.catch(() => {}); return result; };
    let renewing = false;
    let stopped = false;
    const publishRoute = async (route: ExternalRoute) => {
      await mutate(async () => { await identity(connection); await request(connection, "PUT", "/v1/routes", routeBody(route)); });
      if (stopped) { await request(connection, "DELETE", "/v1/routes", routeBody(route)); throw new UserError("control-plane ingress is closed"); }
      routes.set(route.ingressId!, route);
    };
    const timer = setInterval(() => {
      if (renewing || stopped) return;
      renewing = true;
      void (async () => {
        for (const route of routes.values()) {
          if (stopped) break;
          try { await mutate(async () => { if (!stopped && routes.get(route.ingressId!) === route) { await identity(connection); await request(connection, "PUT", "/v1/routes", routeBody(route)); } }); }
          catch { /* Unreachable hosts lose their leases and fail closed; retry next tick. */ }
        }
      })().finally(() => { renewing = false; });
    }, 10_000);
    timer.unref();
    return {
      scheme, domain: connection.domain, listenHost: parsed.listenHost, listenPort: parsed.listenPort,
      ...(parsed.publicPort === undefined ? {} : { port: parsed.publicPort }),
      scopeSubdomain(subdomain, workspaceId) {
        if (subdomain.includes(".")) throw new UserError("control-plane ingress requires a single DNS label under its shared wildcard domain");
        const suffix = `-${createHash("sha256").update(`${connection.hostId}\0${workspaceId}\0${subdomain}`).digest("hex").slice(0, 16)}`;
        return `${subdomain.slice(0, 63 - suffix.length).replace(/-+$/g, "")}${suffix}`;
      },
      publishRoute,
      async revokeRoute(route) {
        routes.delete(route.ingressId!);
        await mutate(() => request(connection, "DELETE", "/v1/routes", routeBody(route)));
      },
      async close() {
        stopped = true; clearInterval(timer);
        await tail;
        await Promise.allSettled([...routes.values()].map((route) => request(connection, "DELETE", "/v1/routes", routeBody(route))));
        routes.clear();
      }
    };
  }
};
function routeBody(route: ExternalRoute) {
  if (!route.ingressId) throw new UserError("control-plane routes require an owned route identity");
  return { routeId: route.ingressId, authorities: [route.authority, ...(route.permalinkAuthority ? [route.permalinkAuthority] : [])] };
}
function parseArgument(argument: string): Argument {
  let value: unknown;
  try { value = JSON.parse(argument); } catch { throw new UserError("control-plane ingress argument must be JSON"); }
  const input = record(value);
  if (Object.keys(input).some((key) => !["connectionFile", "listenHost", "listenPort", "publicPort"].includes(key))
    || typeof input.connectionFile !== "string" || !isAbsolute(input.connectionFile)
    || typeof input.listenHost !== "string" || !input.listenHost
    || input.listenPort !== "auto" && !port(input.listenPort)
    || input.publicPort !== undefined && !port(input.publicPort)) throw new UserError("control-plane ingress requires --connection-file ABSOLUTE_FILE --listen-host HOST --listen-port PORT [--public-port PORT]");
  return input as unknown as Argument;
}
async function readConnection(path: string): Promise<Connection> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > 4096) throw new UserError("control-plane ingress connection must be a private, owned regular file of at most 4 KiB");
    const value = record(JSON.parse(await handle.readFile("utf8")));
    if (Object.keys(value).some((key) => !["schemaVersion", "endpoint", "hostId", "token", "domain"].includes(key)) || value.schemaVersion !== 1
      || typeof value.endpoint !== "string" || !validOrigin(value.endpoint)
      || typeof value.hostId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.hostId)
      || typeof value.token !== "string" || value.token.length < 32 || value.token.length > 256
      || typeof value.domain !== "string" || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,62}$/.test(value.domain)) throw new UserError("invalid control-plane ingress connection");
    return value as unknown as Connection;
  } finally { await handle.close(); }
}
async function identity(connection: Connection) {
  const value = record(await request(connection, "GET", "/v1/identity"));
  if (value.schemaVersion !== 1 || value.hostId !== connection.hostId || value.domain !== connection.domain) throw new UserError("control-plane ingress identity does not match the configured host and domain");
}
async function request(connection: Connection, method: string, path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, connection.endpoint), { method, redirect: "error", signal: AbortSignal.timeout(5000), headers: {
      authorization: `Bearer ${connection.token}`, "x-dim-host-id": connection.hostId, ...(body === undefined ? {} : { "content-type": "application/json" })
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new UserError("control-plane ingress is unreachable; check the private host connection"); }
  if (!response.ok) { await response.body?.cancel(); throw new UserError(response.status === 409 ? "external URL is already claimed by another host or workspace" : "control-plane ingress rejected the host request"); }
  // This endpoint returns only fixed bounded protocol data, never an upstream response.
  const chunks: Uint8Array[] = []; let size = 0;
  if (response.body) for await (const chunk of response.body) { size += chunk.byteLength; if (size > 4096) throw new UserError("invalid control-plane ingress response"); chunks.push(chunk); }
  const content = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(content);
}
function validOrigin(value: string) { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash; } catch { return false; } }
function port(value: unknown) { return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535; }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new UserError("expected an object"); return value as Record<string, unknown>; }
