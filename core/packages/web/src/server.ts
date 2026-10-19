import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { loadReviewerWebConfig, type ReviewerWebConfig } from "./config.js";
import { accountReviewDto, type ReviewDto } from "./dto.js";
import { BodyError, HttpResponseError, readJson, sendEmpty, sendJson } from "./http-response.js";
import { NativeGitClient, NativeGitHttpError, NativeGitClientError } from "./native-client.js";
import { AccountAuthenticator, SessionStore, type AuthenticationState, type ReviewerSession } from "./session.js";
import { serveStaticAsset } from "./static-assets.js";
import { configuredWebOperations, workspaceActionSchema, type WebOperations } from "./operations.js";
import { printableText } from "./text-schema.js";

const DEFAULT_AUTHENTICATION_DERIVATIONS = 2;
const DEFAULT_SESSIONS = 256;
const RETRY_AFTER_SECONDS = "1";
const identifierPattern = "[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?";
const collectionPattern = new RegExp(`^/v1/projects/(${identifierPattern})/repositories/(${identifierPattern})/reviews/resolve$`);
const memberPattern = new RegExp(`^/v1/projects/(${identifierPattern})/repositories/(${identifierPattern})/reviews/([0-9a-f]{64})$`);
const actionPattern = new RegExp(`^/v1/projects/(${identifierPattern})/repositories/(${identifierPattern})/reviews/([0-9a-f]{64})/(approvals|revocations)$`);
const loginSchema = z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }).strict().readonly();
const resolveSchema = z.object({ proposalRef: printableText(1024).min(1) }).strict().readonly();
const emptySchema = z.object({}).strict().readonly();

export type ReviewerWebServerOptions = {
  readonly limits?: {
    readonly authenticationDerivations?: number;
    readonly sessions?: number;
  };
  readonly now?: () => number;
  readonly operations?: WebOperations;
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
  readonly native: NativeGitClient | undefined;
  readonly operations: WebOperations | undefined;
  readonly sessions: SessionStore;
  readonly secureCookie: boolean;
};

export async function createReviewerWebServerFromConfigFile(
  path: string,
  options: ReviewerWebServerOptions = {}
): Promise<ReviewerWebServer> {
  const config = await loadReviewerWebConfig(path);
  const native = config.nativeGit === undefined ? undefined : new NativeGitClient(config.nativeGit);
  try {
    await native?.attest();
  } catch (error) {
    throw new ReviewerWebStartupError("native Git reviewer identity attestation failed; reconnect the control plane and initialize a current reviewer configuration", { cause: error });
  }
  return createReviewerWebServer(config, native, options);
}

function createReviewerWebServer(config: ReviewerWebConfig, native: NativeGitClient | undefined, options: ReviewerWebServerOptions): ReviewerWebServer {
  const now = options.now ?? (() => performance.now());
  const authenticator = new AccountAuthenticator(
    config.accounts,
    options.limits?.authenticationDerivations ?? DEFAULT_AUTHENTICATION_DERIVATIONS,
    now
  );
  const sessions = new SessionStore(config.session, now, options.limits?.sessions ?? DEFAULT_SESSIONS);
  const context = { authenticator, config, native, operations: options.operations ?? (config.operations === undefined ? undefined : configuredWebOperations(config.operations)), sessions, secureCookie: new URL(config.publicOrigin).protocol === "https:" };
  const server = createServer((request, response) => {
    void handleRequest(context, request, response).catch((error: unknown) => {
      if (error instanceof HttpResponseError) return sendJson(response, { status: error.status, body: { error: error.publicMessage } });
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof BodyError) {
        return sendJson(response, { status: 400, body: { error: "invalid request" } });
      }
      if (error instanceof NativeGitClientError) return sendJson(response, { status: 503, body: { error: "review service unavailable" } });
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
  if (url.pathname.startsWith("/v1/operations/")) {
    return handleOperations(context, session, request, response, url.pathname);
  }
  const reviews = new RegExp(`^/v1/projects/(${identifierPattern})/repositories/root/reviews$`).exec(url.pathname);
  if (request.method === "GET" && reviews?.[1] !== undefined) {
    requireScope(context.config, reviews[1], "root");
    return sendJson(response, { status: 200, body: await requireNative(context).listReviews(reviews[1]) });
  }
  const promotion = new RegExp(`^/v1/projects/(${identifierPattern})/repositories/root/reviews/([0-9a-f]{64})/promotions$`).exec(url.pathname);
  if (request.method === "POST" && promotion?.[1] !== undefined && promotion[2] !== undefined) {
    requireScope(context.config, promotion[1], "root"); requireMutation(context.config, request, session);
    if (!accountRoles(context.config, session).includes("operator")) throw new HttpResponseError(403, "operator authority required");
    emptySchema.parse(await readJson(request));
    return sendJson(response, { status: 200, body: await requireNative(context).promote(promotion[1], promotion[2]) });
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
      const review = await requireNative(context).approveReview(projectId, repositoryId, reviewId);
      return sendJson(response, { status: 200, body: reviewBody(context.config, session, review) });
    }
    const review = await requireNative(context).getReview(projectId, repositoryId, reviewId);
    const revokedIds = new Set(review.revocations.map(({ approvalId }) => approvalId));
    const approval = review.approvals.find(({ approvalId, reviewerId }) => (
      reviewerId === context.config.nativeGit?.reviewerId && !revokedIds.has(approvalId)
    ));
    if (approval === undefined) throw new HttpResponseError(409, "no active approval to revoke");
    return sendJson(response, {
      status: 200,
      body: reviewBody(context.config, session, await requireNative(context).revokeApproval(projectId, repositoryId, reviewId, approval.approvalId))
    });
  }
  const member = memberPattern.exec(url.pathname);
  if (request.method === "GET" && member !== null) {
    const projectId = member[1];
    const repositoryId = member[2];
    const reviewId = member[3];
    if (projectId === undefined || repositoryId === undefined || reviewId === undefined) throw new HttpResponseError(404, "not found");
    requireScope(context.config, projectId, repositoryId);
    return sendJson(response, { status: 200, body: reviewBody(context.config, session, await requireNative(context).getReview(projectId, repositoryId, reviewId)) });
  }
  const collection = collectionPattern.exec(url.pathname);
  if (request.method === "POST" && collection !== null) {
    const projectId = collection[1];
    const repositoryId = collection[2];
    if (projectId === undefined || repositoryId === undefined) throw new HttpResponseError(404, "not found");
    requireScope(context.config, projectId, repositoryId);
    requireMutation(context.config, request, session);
    const body = resolveSchema.parse(await readJson(request));
    return sendJson(response, { status: 200, body: reviewBody(context.config, session, await requireNative(context).resolveReview(projectId, body)) });
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
  if (!accountRoles(config, session).includes("reviewer")) throw new HttpResponseError(403, "review action denied");
}

function requireOrigin(config: ReviewerWebConfig, request: IncomingMessage): void {
  if (request.headers.origin !== config.publicOrigin) throw new HttpResponseError(403, "request rejected");
}

function requireScope(config: ReviewerWebConfig, projectId: string, repositoryId: string): void {
  if (projectId !== config.nativeGit?.projectId || repositoryId !== "root") throw new HttpResponseError(404, "not found");
}

function sessionBody(config: ReviewerWebConfig, session: ReviewerSession) {
  return {
    authenticated: true, projectId: config.nativeGit?.projectId ?? "",
    reviewerId: config.nativeGit?.reviewerId ?? "", csrfToken: session.csrfToken,
    roles: accountRoles(config, session), capabilities: { review: config.nativeGit !== undefined, operations: config.operations !== undefined, promotion: config.nativeGit?.promoter !== undefined }
  };
}

function reviewBody(config: ReviewerWebConfig, session: ReviewerSession, review: ReviewDto) {
  return accountReviewDto(review, accountRoles(config, session).includes("reviewer"));
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

function accountRoles(config: ReviewerWebConfig, session: ReviewerSession) {
  return config.accounts.find((account) => account.username === session.accountId)?.roles ?? [];
}
function requireNative(context: RequestContext): NativeGitClient {
  if (!context.native) throw new HttpResponseError(404, "review service is not configured");
  return context.native;
}
async function handleOperations(context: RequestContext, session: ReviewerSession, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
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
  const job = /^\/v1\/operations\/ci\/jobs\/([0-9a-f-]{36})(?:\/(cancel|retry))?$/.exec(path);
  let body: unknown;
  try {
    if (request.method === "GET" && path === "/v1/operations/status") {
      body = { hosts: await operations.hosts(), ci: context.config.operations.ci !== undefined, ciOperator: context.config.operations.ci?.operatorConnection !== undefined, review: context.native !== undefined,
        consoles: context.config.operations.consoles, generationId: context.config.nativeGit?.generationId ?? null };
    } else if (host?.[1] !== undefined && request.method === "GET") body = await operations.workspaces(host[1]);
    else if (host?.[1] !== undefined && mutation) {
      await operations.workspaceAction(host[1], workspaceActionSchema.parse(await readJson(request))); body = { accepted: true };
    } else if (request.method === "GET" && path === "/v1/operations/ci/jobs") body = await operations.jobs();
    else if (request.method === "GET" && path === "/v1/operations/ci/workers") body = await operations.workers();
    else if (job?.[1] !== undefined && request.method === "GET" && job[2] === undefined) body = await operations.detail(z.string().uuid().parse(job[1]));
    else if (job?.[1] !== undefined && mutation && job[2] === "cancel") {
      emptySchema.parse(await readJson(request)); body = await operations.cancel(z.string().uuid().parse(job[1]));
    } else if (job?.[1] !== undefined && mutation && job[2] === "retry") {
      const input = z.object({ requestId: z.string().uuid() }).strict().parse(await readJson(request));
      body = await operations.retry(z.string().uuid().parse(job[1]), input.requestId);
    } else throw new HttpResponseError(404, "not found");
  } catch (error) {
    if (error instanceof HttpResponseError || error instanceof z.ZodError || error instanceof BodyError) throw error;
    throw new HttpResponseError(503, "operations service unavailable; verify the connected generation");
  }
  return sendJson(response, { status: 200, body });
}
