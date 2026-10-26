import { handleAccounts } from "./account-http.js";
import { webPluginContext } from "./controllers.js";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import {accountRoles,expiredCookie,requireCurrentSession,requireMutation,requireOrigin,requireSession,sendAuthenticationBusy,sessionBody,sessionCookie} from './session-http.js';
import { loadWebConfig, type WebConfig } from "./config.js";
import { BodyError, HttpResponseError, readJson, sendEmpty, sendJson } from "./http-response.js";
import { AccountAuthenticator, SessionStore, type AuthenticationState, type WebSession } from "./session.js";
import { serveStaticAsset } from "./static-assets.js";
import { loadWebPlugins, webPluginCatalog, invokeWebPlugin, serveWebPluginAsset, reconnectWebPlugin, type LoadedWebPlugin } from "./plugins.js";
import { configuredWebOperations, workspaceActionSchema, workspaceCreateSchema, type WebOperations } from "./operations.js";

const DEFAULT_AUTHENTICATION_DERIVATIONS = 2;
const DEFAULT_SESSIONS = 256;
const loginSchema = z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }).strict().readonly();

export type WebServerOptions = {
  readonly limits?: {
    readonly authenticationDerivations?: number;
    readonly sessions?: number;
  };
  readonly now?: () => number;
  readonly operations?: WebOperations;
};
export type WebRuntimeState = {
  readonly authentication: AuthenticationState;
  readonly sessions: number;
};
export type WebServer = {
  readonly server: Server;
  listen(): Promise<string>;
  close(): Promise<void>;
  runtimeState(): WebRuntimeState;
};
type RequestContext = {
  readonly accountConfigPath: string;
  readonly authenticator: AccountAuthenticator;
  config: WebConfig;
  readonly operations: WebOperations | undefined;
  readonly sessions: SessionStore;
  readonly secureCookie: boolean;
  readonly plugins: readonly LoadedWebPlugin[];
};

export async function createWebServerFromConfigFile(
  path: string,
  options: WebServerOptions = {}
): Promise<WebServer> {
  const config = await loadWebConfig(path);
  return createWebServer(config, options, await loadWebPlugins(config.plugins, config.pluginHome, webPluginContext(config.operations?.hosts)), path);
}

function createWebServer(config: WebConfig, options: WebServerOptions, plugins: readonly LoadedWebPlugin[], accountConfigPath: string): WebServer {
  const now = options.now ?? (() => performance.now());
  const authenticator = new AccountAuthenticator(
    config.accounts,
    options.limits?.authenticationDerivations ?? DEFAULT_AUTHENTICATION_DERIVATIONS,
    now
  );
  const sessions = new SessionStore(config.session, now, options.limits?.sessions ?? DEFAULT_SESSIONS);
  const context = { accountConfigPath, plugins, authenticator, config, operations: options.operations ?? (config.operations === undefined ? undefined : configuredWebOperations(config.operations)), sessions, secureCookie: new URL(config.publicOrigin).protocol === "https:" };
  const server = createServer((request, response) => {
    void handleRequest(context, request, response).catch((error: unknown) => {
      if (error instanceof HttpResponseError) return sendJson(response, { status: error.status, body: { error: error.publicMessage, ...(error.code ? { code: error.code } : {}) } });
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof BodyError) {
        return sendJson(response, { status: 400, body: { error: "invalid request" } });
      }
      return sendJson(response, { status: 500, body: { error: "request failed" } });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  return {
    server,
    async listen() {
      server.listen(config.port, config.host);
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new WebStartupError("expected TCP listener");
      return `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${address.port}`;
    },
    async close() {
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
    runtimeState() {
      return { authentication: authenticator.state(), sessions: sessions.size() };
    }
  };
}

async function handleRequest(context: RequestContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dim-web");
  if (url.search !== "") throw new HttpResponseError(404, "not found");
  if (request.method === "GET" && await serveStaticAsset(url.pathname, response)) return;
  if (request.method === "GET" && url.pathname === "/healthz") return sendJson(response, { status: 200, body: { status: "ok" } });
  if (request.method === "POST" && url.pathname === "/v1/session") return login(context, request, response);
  const session = requireSession(context.sessions, request);
  if (request.method === "GET" && url.pathname === "/v1/session") return sendJson(response, { status: 200, body: sessionBody(context, session) });
  if (request.method === "DELETE" && url.pathname === "/v1/session") {
    requireMutation(context.config, request, session);
    context.sessions.delete(session.id);
    return sendEmpty(response, 204, { "Set-Cookie": expiredCookie(context.secureCookie) });
  }
  if (url.pathname === "/v1/accounts") return handleAccounts(context, session, request, response);
  if (request.method === "GET" && url.pathname === "/v1/extensions") {
    return sendJson(response, { status: 200, body: webPluginCatalog(context.plugins, accountRoles(context.config, session)) });
  }
  const reconnect = /^\/v1\/extensions\/([a-z][a-z0-9-]{0,63})\/reconnect$/.exec(url.pathname);
  if (request.method === "POST" && reconnect) {
    requireMutation(context.config, request, session);
    const plugin = context.plugins.find(({ definition }) => definition.id === reconnect[1]);
    if (!plugin) throw new HttpResponseError(404, "feature not found");
    z.object({}).strict().parse(await readJson(request));
    requireCurrentSession(context.sessions, session);
    await reconnectWebPlugin(plugin);
    requireCurrentSession(context.sessions, session);
    return sendJson(response, { status: 200, body: webPluginCatalog([plugin], accountRoles(context.config, session))[0] });
  }
  const extension = /^\/v1\/extensions\/([a-z][a-z0-9-]{0,63})\/(assets|operations)\/([a-zA-Z0-9._-]{1,160})$/.exec(url.pathname);
  if (extension) {
    const plugin = context.plugins.find(({ definition }) => definition.id === extension[1]);
    if (!plugin) throw new HttpResponseError(404, "feature not found");
    if (extension[2] === "assets" && request.method === "GET") return serveWebPluginAsset(plugin, extension[3]!, response);
    if (extension[2] === "operations" && request.method === "POST") {
      requireMutation(context.config, request, session);
      const input = await readJson(request);
      requireCurrentSession(context.sessions, session);
      const result = await invokeWebPlugin(plugin, extension[3]!, input, accountRoles(context.config, session), expectedPluginGeneration(request));
      requireCurrentSession(context.sessions, session);
      return sendJson(response, { status: 200, body: result });
    }
    throw new HttpResponseError(404, "not found");
  }
  if (url.pathname.startsWith("/v1/operations/")) {
    return handleOperations(context, session, request, response, url.pathname);
  }
  throw new HttpResponseError(404, "not found");
}

function expectedPluginGeneration(request: IncomingMessage): number | undefined {
  const value = request.headers["x-dim-plugin-generation"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new HttpResponseError(400, "invalid feature generation");
  const generation = Number(value);
  if (!Number.isSafeInteger(generation)) throw new HttpResponseError(400, "invalid feature generation");
  return generation;
}

async function login(context: RequestContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.headers.origin !== context.config.publicOrigin) {
    throw new HttpResponseError(403, `Open this console at ${context.config.publicOrigin} and sign in again. The address must match the configured public URL.`);
  }
  requireOrigin(context.config, request);
  context.sessions.pruneExpired();
  let input;
  try {
    input = loginSchema.parse(await readJson(request));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof BodyError) throw new HttpResponseError(400, "invalid request");
    throw error;
  }
  const authentication = await context.authenticator.authenticate(input.username, input.password);
  switch (authentication.kind) {
    case "busy":
      return sendAuthenticationBusy(response);
    case "rejected":
      throw new HttpResponseError(401, "authentication failed");
    case "accepted": {
      const session = context.sessions.create(authentication.accountId);
      if (session === undefined) return sendAuthenticationBusy(response);
      return sendJson(response, {
        status: 201,
        body: sessionBody(context, session),
        headers: { "Set-Cookie": sessionCookie(session.id, context.secureCookie) }
      });
    }
    default:
      return assertNever(authentication);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected authentication result: ${String(value)}`);
}

export class WebStartupError extends Error { readonly name = "WebStartupError"; }

async function handleOperations(context: RequestContext, session: WebSession, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const operations = context.operations;
  if (!operations || !context.config.operations) throw new HttpResponseError(404, "operations are not configured");
  const roles = accountRoles(context.config, session);
  if (!roles.includes("read") && !roles.includes("operator")) throw new HttpResponseError(403, "operations access denied");
  const mutation = request.method === "POST";
  if (mutation) {
    requireMutation(context.config, request, session);
    if (!roles.includes("operator")) throw new HttpResponseError(403, "operator authority required");
  }
  const host = /^\/v1\/operations\/hosts\/([a-z0-9._-]{1,128})\/workspaces$/.exec(path);
  const creation = /^\/v1\/operations\/hosts\/([a-z0-9._-]{1,128})\/workspaces\/create$/.exec(path);
  let body: unknown;
  try {
    if (request.method === "GET" && path === "/v1/operations/status") {
      body = { hosts: await operations.hosts(), consoles: context.config.operations.consoles };
    } else if (creation?.[1] !== undefined && mutation) {
      await operations.workspaceCreate(creation[1], workspaceCreateSchema.parse(await readJson(request))); body = { accepted: true };
    } else if (host?.[1] !== undefined && request.method === "GET") body = await operations.workspaces(host[1]);
    else if (host?.[1] !== undefined && mutation) {
      await operations.workspaceAction(host[1], workspaceActionSchema.parse(await readJson(request))); body = { accepted: true };
    } else throw new HttpResponseError(404, "not found");
  } catch (error) {
    if (error instanceof HttpResponseError || error instanceof z.ZodError || error instanceof BodyError) throw error;
    throw new HttpResponseError(503, "operations service unavailable; verify the connected generation");
  }
  requireCurrentSession(context.sessions, session);
  return sendJson(response, { status: 200, body });
}
