import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { loadReviewerWebConfig, type ReviewerWebConfig } from "./config.js";
import { accountReviewDto, type ReviewDto } from "./dto.js";
import { BodyError, HttpResponseError, readJson, sendEmpty, sendJson } from "./http-response.js";
import { NativeGitClient, NativeGitHttpError } from "./native-client.js";
import { AccountAuthenticator, SessionStore, type AuthenticationState, type ReviewerSession } from "./session.js";
import { serveStaticAsset } from "./static-assets.js";
import { printableText } from "./text-schema.js";

const DEFAULT_AUTHENTICATION_DERIVATIONS = 2;
const DEFAULT_SESSIONS = 256;
const RETRY_AFTER_SECONDS = "1";
const identifierPattern = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const collectionPattern = new RegExp(`^/v1/projects/(${identifierPattern})/repositories/(${identifierPattern})/reviews$`);
const memberPattern = new RegExp(`^/v1/projects/(${identifierPattern})/repositories/(${identifierPattern})/reviews/([0-9a-f]{64})$`);
const actionPattern = new RegExp(`^/v1/projects/(${identifierPattern})/repositories/(${identifierPattern})/reviews/([0-9a-f]{64})/(approvals|revocations)$`);
const loginSchema = z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }).strict().readonly();
const createSchema = z.object({ protectedRef: printableText(1024).min(1), proposalRef: printableText(1024).min(1) }).strict().readonly();
const emptySchema = z.object({}).strict().readonly();

export type ReviewerWebServerOptions = {
  readonly limits?: {
    readonly authenticationDerivations?: number;
    readonly sessions?: number;
  };
  readonly now?: () => number;
};
export type ReviewerWebRuntimeState = {
  readonly authentication: AuthenticationState;
  readonly sessions: number;
};
export type ReviewerWebServer = {
  readonly server: Server;
  listen(): Promise<string>;
  close(): Promise<void>;
  runtimeState(): ReviewerWebRuntimeState;
};
type RequestContext = {
  readonly authenticator: AccountAuthenticator;
  readonly config: ReviewerWebConfig;
  readonly native: NativeGitClient;
  readonly sessions: SessionStore;
  readonly secureCookie: boolean;
};

export async function createReviewerWebServerFromConfigFile(
  path: string,
  options: ReviewerWebServerOptions = {}
): Promise<ReviewerWebServer> {
  const config = await loadReviewerWebConfig(path);
  const native = new NativeGitClient(config.nativeGit);
  try {
    await native.attest();
  } catch (error) {
    throw new ReviewerWebStartupError("native Git reviewer identity attestation failed", { cause: error });
  }
  return createReviewerWebServer(config, native, options);
}

function createReviewerWebServer(config: ReviewerWebConfig, native: NativeGitClient, options: ReviewerWebServerOptions): ReviewerWebServer {
  const now = options.now ?? (() => performance.now());
  const authenticator = new AccountAuthenticator(
    config.accounts,
    options.limits?.authenticationDerivations ?? DEFAULT_AUTHENTICATION_DERIVATIONS,
    now
  );
  const sessions = new SessionStore(config.session, now, options.limits?.sessions ?? DEFAULT_SESSIONS);
  const context = { authenticator, config, native, sessions, secureCookie: new URL(config.publicOrigin).protocol === "https:" };
  const server = createServer((request, response) => {
    void handleRequest(context, request, response).catch((error: unknown) => {
      if (error instanceof HttpResponseError) return sendJson(response, { status: error.status, body: { error: error.publicMessage } });
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof BodyError) {
        return sendJson(response, { status: 400, body: { error: "invalid request" } });
      }
      if (error instanceof NativeGitHttpError) {
        if (error.status === 404) return sendJson(response, { status: 404, body: { error: "review not found" } });
        if (error.status === 409) return sendJson(response, { status: 409, body: { error: "review is stale" } });
        if (error.status === 403) return sendJson(response, { status: 403, body: { error: "review action denied" } });
        return sendJson(response, { status: 503, body: { error: "review service unavailable" } });
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
      if (address === null || typeof address === "string") throw new ReviewerWebStartupError("expected TCP listener");
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
  const url = new URL(request.url ?? "/", "http://dim-reviewer-web");
  if (url.search !== "") throw new HttpResponseError(404, "not found");
  if (request.method === "GET" && await serveStaticAsset(url.pathname, response)) return;
  if (request.method === "GET" && url.pathname === "/healthz") return sendJson(response, { status: 200, body: { status: "ok" } });
  if (request.method === "POST" && url.pathname === "/v1/session") return login(context, request, response);
  const session = requireSession(context.sessions, request);
  if (request.method === "GET" && url.pathname === "/v1/session") return sendJson(response, { status: 200, body: sessionBody(context.config, session) });
  if (request.method === "DELETE" && url.pathname === "/v1/session") {
    requireMutation(context.config, request, session);
    context.sessions.delete(session.id);
    return sendEmpty(response, 204, { "Set-Cookie": expiredCookie(context.secureCookie) });
  }
  const action = actionPattern.exec(url.pathname);
  if (request.method === "POST" && action !== null) {
    const projectId = action[1];
    const repositoryId = action[2];
    const reviewId = action[3];
    const actionName = action[4];
    if (projectId === undefined || repositoryId === undefined || reviewId === undefined || actionName === undefined) {
      throw new HttpResponseError(404, "not found");
    }
    requireScope(context.config, projectId, repositoryId);
    requireMutation(context.config, request, session);
    requireDecisionAuthority(context.config, session);
    emptySchema.parse(await readJson(request));
    if (actionName === "approvals") {
      const review = await context.native.approveReview(projectId, repositoryId, reviewId);
      return sendJson(response, { status: 200, body: reviewBody(context.config, session, review) });
    }
    const review = await context.native.getReview(projectId, repositoryId, reviewId);
    const revokedIds = new Set(review.revocations.map(({ approvalId }) => approvalId));
    const approval = review.approvals.find(({ approvalId, reviewerId }) => (
      reviewerId === context.config.nativeGit.reviewerId && !revokedIds.has(approvalId)
    ));
    if (approval === undefined) throw new HttpResponseError(409, "no active approval to revoke");
    return sendJson(response, {
      status: 200,
      body: reviewBody(context.config, session, await context.native.revokeApproval(projectId, repositoryId, reviewId, approval.approvalId))
    });
  }
  const member = memberPattern.exec(url.pathname);
  if (request.method === "GET" && member !== null) {
    const projectId = member[1];
    const repositoryId = member[2];
    const reviewId = member[3];
    if (projectId === undefined || repositoryId === undefined || reviewId === undefined) throw new HttpResponseError(404, "not found");
    requireScope(context.config, projectId, repositoryId);
    return sendJson(response, { status: 200, body: reviewBody(context.config, session, await context.native.getReview(projectId, repositoryId, reviewId)) });
  }
  const collection = collectionPattern.exec(url.pathname);
  if (request.method === "POST" && collection !== null) {
    const projectId = collection[1];
    const repositoryId = collection[2];
    if (projectId === undefined || repositoryId === undefined) throw new HttpResponseError(404, "not found");
    requireScope(context.config, projectId, repositoryId);
    requireMutation(context.config, request, session);
    const body = createSchema.parse(await readJson(request));
    return sendJson(response, { status: 201, body: reviewBody(context.config, session, await context.native.createReview(projectId, repositoryId, body)) });
  }
  throw new HttpResponseError(404, "not found");
}

async function login(context: RequestContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
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
      return sendBusy(response);
    case "rejected":
      throw new HttpResponseError(401, "authentication failed");
    case "accepted": {
      const session = context.sessions.create(authentication.accountId);
      if (session === undefined) return sendBusy(response);
      return sendJson(response, {
        status: 201,
        body: sessionBody(context.config, session),
        headers: { "Set-Cookie": sessionCookie(session.id, context.secureCookie) }
      });
    }
    default:
      return assertNever(authentication);
  }
}

function requireSession(sessions: SessionStore, request: IncomingMessage): ReviewerSession {
  const values = (request.headers.cookie ?? "").split(";").map((value) => value.trim()).filter((value) => value.startsWith("dim_session="));
  const id = values.length === 1 ? values[0]?.slice("dim_session=".length) : undefined;
  const session = id === undefined || !/^[A-Za-z0-9_-]{43}$/.test(id) ? undefined : sessions.get(id);
  if (session === undefined) throw new HttpResponseError(401, "authentication required");
  return session;
}

function requireMutation(config: ReviewerWebConfig, request: IncomingMessage, session: ReviewerSession): void {
  requireOrigin(config, request);
  const supplied = request.headers["x-dim-csrf"];
  if (typeof supplied !== "string" || !constantEqual(supplied, session.csrfToken)) throw new HttpResponseError(403, "request rejected");
}

function requireDecisionAuthority(config: ReviewerWebConfig, session: ReviewerSession): void {
  if (session.accountId !== config.reviewerAccountId) throw new HttpResponseError(403, "review action denied");
}

function requireOrigin(config: ReviewerWebConfig, request: IncomingMessage): void {
  if (request.headers.origin !== config.publicOrigin) throw new HttpResponseError(403, "request rejected");
}

function requireScope(config: ReviewerWebConfig, projectId: string, repositoryId: string): void {
  if (projectId !== config.nativeGit.projectId || !config.nativeGit.repositoryIds.includes(repositoryId)) throw new HttpResponseError(404, "not found");
}

function sessionBody(config: ReviewerWebConfig, session: ReviewerSession) {
  return {
    authenticated: true, projectId: config.nativeGit.projectId, repositoryIds: config.nativeGit.repositoryIds,
    reviewerId: config.nativeGit.reviewerId, csrfToken: session.csrfToken
  };
}

function reviewBody(config: ReviewerWebConfig, session: ReviewerSession, review: ReviewDto) {
  return accountReviewDto(review, session.accountId === config.reviewerAccountId);
}

function constantEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sessionCookie(id: string, secure: boolean): string {
  return `dim_session=${id}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function expiredCookie(secure: boolean): string {
  return `dim_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function sendBusy(response: ServerResponse): void {
  sendJson(response, {
    status: 429,
    body: { error: "authentication temporarily unavailable" },
    headers: { "Retry-After": RETRY_AFTER_SECONDS }
  });
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected authentication result: ${String(value)}`);
}

export class ReviewerWebStartupError extends Error { readonly name = "ReviewerWebStartupError"; }
