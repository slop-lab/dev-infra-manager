import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { nativeGitAuthenticator } from "./auth.js";
import { serveGitBackend } from "./backend.js";
import {
  parseNativeGitServiceConfig,
  repositoryKey,
  type NativeGitIdentity,
  type NativeGitServiceConfig
} from "./config.js";
import {
  assertGitExecutableIdentity,
  assertGitVersion,
  assertRegisteredRepository,
  type GitExecutableIdentity
} from "./repository.js";
import { nativeGitReviewRoute, serveReviewApi } from "./review-http.js";
import { createPromotionService } from "./promotion-service.js";
import { createRefSerializer } from "./ref-serializer.js";
import { createReviewService } from "./review-service.js";
import { nativeGitRoute } from "./routing.js";
import { acquireStorageOwner, type StorageOwner } from "./storage-owner.js";

export type NativeGitServer = {
  readonly server: Server;
  listen(): Promise<string>;
  close(): Promise<void>;
};

export function createNativeGitServer(input: NativeGitServiceConfig): NativeGitServer {
  const config = parseNativeGitServiceConfig(input);
  const repositories = new Map(config.repositories.map((repository) => [
    repositoryKey(repository.projectId, repository.repositoryId), repository
  ]));
  const authenticator = nativeGitAuthenticator(config.identities);
  const serializer = createRefSerializer();
  const services = {
    review: createReviewService(config, serializer),
    promotion: createPromotionService(config, serializer)
  };
  let gitIdentity: GitExecutableIdentity | undefined;
  let storageOwner: StorageOwner | undefined;
  let activeBackends = 0;
  const server = createServer((request, response) => {
    const reviewRoute = nativeGitReviewRoute(request);
    if (reviewRoute !== undefined) {
      const identity = authenticator.authenticate(request.headers);
      if (identity === undefined) return send(response, 401, { "WWW-Authenticate": 'Basic realm="DIM Git Review"' });
      if (gitIdentity === undefined) return send(response, 503);
      void assertGitExecutableIdentity(config.gitExecutable, gitIdentity)
        .then(() => serveReviewApi(services, identity, reviewRoute, request, response))
        .catch(() => send(response, 503));
      return;
    }
    const route = nativeGitRoute(request);
    if (route === undefined) return send(response, 404);
    const identity = authenticator.authenticate(request.headers);
    if (identity === undefined) return send(response, 401, { "WWW-Authenticate": 'Basic realm="DIM Git"' });
    const repository = repositories.get(repositoryKey(route.projectId, route.repositoryId));
    if (repository === undefined || !canAccess(identity, route.projectId, route.repositoryId)) return send(response, 404);
    if (route.operation === "write" && identity.role !== "writer") return send(response, 403);
    if (gitIdentity === undefined) return send(response, 503);
    if (activeBackends >= 16) return send(response, 503);
    activeBackends += 1;
    void assertGitExecutableIdentity(config.gitExecutable, gitIdentity)
      .then(() => serveGitBackend(config, identity, route, request, response))
      .catch(() => send(response, 503))
      .finally(() => { activeBackends -= 1; });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;

  return {
    server,
    async listen() {
      storageOwner = await acquireStorageOwner(config.storageRoot);
      try {
        gitIdentity = await assertGitVersion(config);
        await Promise.all(config.repositories.map((repository) => assertRegisteredRepository(config, repository)));
        server.listen(config.port, config.host);
        await once(server, "listening");
        const address = server.address();
        if (address === null || typeof address === "string") throw new NativeGitListenError("expected a TCP listener");
        return `http://${config.host}:${address.port}`;
      } catch (error) {
        await storageOwner.release();
        storageOwner = undefined;
        throw error;
      }
    },
    async close() {
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
      await storageOwner?.release();
      storageOwner = undefined;
    }
  };
}

function canAccess(identity: NativeGitIdentity, projectId: string, repositoryId: string): boolean {
  return identity.projectId === projectId && identity.repositoryIds.includes(repositoryId);
}

function send(response: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  response.writeHead(status, { "Cache-Control": "no-store", ...headers }).end();
}

class NativeGitListenError extends Error {
  readonly name = "NativeGitListenError";
}
