import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { serveGitBackend } from "./backend.js";
import { repositoryRoute, type RepositoryOperation } from "./routing.js";
import { assertGitExecutableIdentity, assertGitVersion, assertRegisteredRepository, assertRepositorySelector,
  GitRepositoryError, type GitRepositoryRuntime, type RepositorySelector } from "./repository.js";

export interface RepositoryPolicy {
  readonly selector: RepositorySelector;
  readonly protectedRefs: readonly string[];
}
export interface RepositoryGrant {
  readonly selector: RepositorySelector;
  readonly principalId: string;
  readonly role: "reader" | "writer";
}
export interface RepositoryServiceOptions {
  readonly runtime: GitRepositoryRuntime;
  readonly repositories: readonly RepositoryPolicy[];
  readonly authorize: (input: { readonly request: IncomingMessage; readonly selector: RepositorySelector;
    readonly operation: RepositoryOperation; readonly signal: AbortSignal }) => Promise<RepositoryGrant | undefined>;
}

export async function createRepositoryService(options: RepositoryServiceOptions): Promise<Server> {
  if (typeof options.authorize !== "function") throw new GitRepositoryError("a repository-scoped authorization provider is required");
  const gitIdentity = await assertGitVersion(options.runtime), policies = new Map<string, RepositoryPolicy>();
  const execute = promisify(execFile);
  for (const policy of options.repositories) {
    assertRepositorySelector(policy.selector);
    const key = repositoryKey(policy.selector);
    if (policies.has(key) || !policy.protectedRefs.length) throw new GitRepositoryError("duplicate repository or missing protected-ref policy");
    for (const ref of policy.protectedRefs) {
      if (!ref.startsWith("refs/heads/")) throw new GitRepositoryError("protected refs must name branches");
      await execute(options.runtime.gitExecutable, ["check-ref-format", ref], {
        env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" }, timeout: 10_000
      });
    }
    await assertRegisteredRepository(options.runtime, policy.selector);
    policies.set(key, { selector: { ...policy.selector }, protectedRefs: [...policy.protectedRefs] });
  }
  const writes = new Map<string, Promise<void>>();
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(503).end(); else response.destroy();
    });
  });
  server.headersTimeout = 5000; server.requestTimeout = 30_000; server.keepAliveTimeout = 1000;
  return server;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = repositoryRoute(request);
    if (!route) { response.writeHead(404).end(); return; }
    const selector = { namespaceId: route.namespaceId, repositoryId: route.repositoryId };
    const policy = policies.get(repositoryKey(selector));
    if (!policy) { response.writeHead(404).end(); return; }
    const abort = new AbortController(), stop = () => abort.abort();
    request.once("aborted", stop); response.once("close", stop);
    const timeout = setTimeout(() => { stop(); if (!response.headersSent) response.writeHead(503).end(); else response.destroy(); }, 30_000);
    timeout.unref();
    try {
      const serve = async () => {
        abort.signal.throwIfAborted();
        const grant = await options.authorize({ request, selector, operation: route.operation, signal: abort.signal });
        abort.signal.throwIfAborted();
        if (!grant) { response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Git service"' }).end(); return; }
        assertRepositorySelector(grant.selector);
        if (repositoryKey(grant.selector) !== repositoryKey(selector)) { response.writeHead(404).end(); return; }
        if (typeof grant.principalId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(grant.principalId)
          || !["reader", "writer"].includes(grant.role) || route.operation === "write" && grant.role !== "writer") {
          response.writeHead(403).end(); return;
        }
        await assertGitExecutableIdentity(options.runtime.gitExecutable, gitIdentity);
        await assertRegisteredRepository(options.runtime, selector);
        abort.signal.throwIfAborted();
        const identity = grant.role === "writer"
          ? { role: "writer" as const, username: grant.principalId, principalId: grant.principalId }
          : { role: "reader" as const, username: grant.principalId };
        await serveGitBackend({ config: options.runtime, route, request, response, identity, protectedRefs: policy.protectedRefs });
      };
      if (route.operation === "write") await serializeWrite(repositoryKey(selector), serve); else await serve();
    } finally { clearTimeout(timeout); request.off("aborted", stop); response.off("close", stop); }
  }

  async function serializeWrite(key: string, operation: () => Promise<void>): Promise<void> {
    const pending = (writes.get(key) ?? Promise.resolve()).then(operation);
    const barrier = pending.then(() => undefined, () => undefined);
    writes.set(key, barrier);
    try { await pending; } finally { if (writes.get(key) === barrier) writes.delete(key); }
  }
}

function repositoryKey(selector: RepositorySelector): string { return `${selector.namespaceId}/${selector.repositoryId}`; }
