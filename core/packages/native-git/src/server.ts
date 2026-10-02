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
import { assertGitVersion, assertRegisteredRepository } from "./repository.js";
import { nativeGitRoute } from "./routing.js";

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
  const server = createServer((request, response) => {
    const route = nativeGitRoute(request);
    if (route === undefined) return send(response, 404);
    const identity = authenticator.authenticate(request.headers);
    if (identity === undefined) return send(response, 401, { "WWW-Authenticate": 'Basic realm="DIM Git"' });
    const repository = repositories.get(repositoryKey(route.projectId, route.repositoryId));
    if (repository === undefined || !canAccess(identity, route.projectId, route.repositoryId)) return send(response, 404);
    if (route.operation === "write" && identity.role !== "writer") return send(response, 403);
    serveGitBackend(config, identity, route, request, response);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;

  return {
    server,
    async listen() {
      await assertGitVersion(config);
      await Promise.all(config.repositories.map((repository) => assertRegisteredRepository(config.storageRoot, repository)));
      server.listen(config.port, config.host);
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new NativeGitListenError("expected a TCP listener");
      return `http://${config.host}:${address.port}`;
    },
    async close() {
      if (!server.listening) return;
      server.close();
      await once(server, "close");
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
