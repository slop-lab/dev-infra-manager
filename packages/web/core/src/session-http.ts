import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { WebConfig } from "./config.js";
import { HttpResponseError, sendJson } from "./http-response.js";
import type { SessionStore, WebSession } from "./session.js";

export function requireSession(sessions: SessionStore, request: IncomingMessage): WebSession {
  const values = (request.headers.cookie ?? "").split(";").map((value) => value.trim()).filter((value) => value.startsWith("dim_session="));
  const id = values.length === 1 ? values[0]?.slice("dim_session=".length) : undefined;
  const session = id === undefined || !/^[A-Za-z0-9_-]{43}$/.test(id) ? undefined : sessions.get(id);
  if (session === undefined) throw new HttpResponseError(401, "authentication required");
  return session;
}

export function requireOrigin(config: WebConfig, request: IncomingMessage): void {
  if (request.headers.origin !== config.publicOrigin) throw new HttpResponseError(403, "request rejected");
}

export function requireMutation(config: WebConfig, request: IncomingMessage, session: WebSession): void {
  requireOrigin(config, request);
  const supplied = request.headers["x-dim-csrf"];
  if (typeof supplied !== "string" || !constantEqual(supplied, session.csrfToken)) throw new HttpResponseError(403, "request rejected");
}

export function requireCurrentSession(sessions: SessionStore, session: WebSession): void {
  if (sessions.get(session.id) !== session) throw new HttpResponseError(401, "authentication required");
}

export function accountRoles(config: WebConfig, session: WebSession) {
  return config.accounts.find((account) => account.username === session.accountId)?.roles ?? [];
}

export function sessionBody(context: { readonly config: WebConfig; readonly accountConfigPath: string }, session: WebSession) {
  const roles = accountRoles(context.config, session);
  return { authenticated: true, username: session.accountId, csrfToken: session.csrfToken, roles,
    capabilities: { operations: context.config.operations !== undefined },
    ...(roles.includes("operator") ? { accountAdministration: {
      command: [process.execPath, fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../dist/cli.js" : "./cli.js", import.meta.url)), "account"],
      configPath: context.accountConfigPath
    } } : {}) };
}

function constantEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left), rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function sessionCookie(id: string, secure: boolean): string {
  return `dim_session=${id}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function expiredCookie(secure: boolean): string {
  return `dim_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function sendAuthenticationBusy(response: ServerResponse): void {
  sendJson(response, {
    status: 429,
    body: { error: "authentication temporarily unavailable" },
    headers: { "Retry-After": "1" }
  });
}
