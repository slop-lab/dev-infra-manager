import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  nativeGitAuthenticator,
  ordinaryAuthorityAuthenticator,
  ordinaryCiServiceAuthenticator
} from "./auth.js";
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
import { createOrdinaryExecutionService } from "./ordinary-execution-service.js";
import { createRefSerializer } from "./ref-serializer.js";
import { createReviewService } from "./review-service.js";
import { nativeGitRoute } from "./routing.js";
import { acquireStorageOwner, type StorageOwner } from "./storage-owner.js";
import {
  boundedAdmissionVerifier,
  rejectingAdmissionVerifier,
  type AdmissionVerifier
} from "./admission-verifier.js";
import {
  createOrdinaryAdmissionVerifier,
  type AdmissionVerifierHttpClient
} from "./ordinary-admission-http.js";
import { createOrdinaryAuthorityService, ordinaryAuthorityRoute } from "./ordinary-authority-http.js";
import {
  createNativeEventDispatcher,
  createNodeNativeEventHttpClient,
  type NativeEventHttpClient
} from "./native-event-dispatcher.js";

export type NativeGitServer = {
  readonly server: Server;
  listen(): Promise<string>;
  close(): Promise<void>;
};

export function createNativeGitServer(
  input: NativeGitServiceConfig,
  admissionVerifier: AdmissionVerifier = rejectingAdmissionVerifier(),
  admissionVerifierTimeoutMilliseconds?: number
): NativeGitServer {
  return createNativeGitServerWithDependencies(input, {
    admissionVerifier,
    eventHttpClient: createNodeNativeEventHttpClient(),
    ...(admissionVerifierTimeoutMilliseconds === undefined ? {} : { admissionVerifierTimeoutMilliseconds })
  });
}

export type NativeGitServerDependencies = {
  readonly admissionVerifier?: AdmissionVerifier;
  readonly admissionVerifierTimeoutMilliseconds?: number;
  readonly eventHttpClient?: NativeEventHttpClient;
};

export function createNativeGitServerWithDependencies(
  input: NativeGitServiceConfig,
  dependencies: NativeGitServerDependencies = {}
): NativeGitServer {
  const config = parseNativeGitServiceConfig(input);
  const admissionVerifier = dependencies.admissionVerifier ?? rejectingAdmissionVerifier();
  const repositories = new Map(config.repositories.map((repository) => [
    repositoryKey(repository.projectId, repository.repositoryId), repository
  ]));
  const authenticator = nativeGitAuthenticator(config.identities);
  const serviceAuthenticator = config.ordinaryCi === undefined
    ? undefined
    : ordinaryCiServiceAuthenticator(config.ordinaryCi);
  const serializer = createRefSerializer();
  const eventDispatcher = config.ordinaryCi === undefined ? undefined : createNativeEventDispatcher({
    config,
    httpClient: dependencies.eventHttpClient ?? createNodeNativeEventHttpClient()
  });
  const ordinaryAuthority = config.ordinaryCi === undefined ? undefined : createOrdinaryAuthorityService(
    config,
    serializer,
    ordinaryAuthorityAuthenticator(config.ordinaryCi.identity)
  );
  const services = {
    review: createReviewService(config, serializer, () => eventDispatcher?.wake()),
    promotion: createPromotionService(
      config,
      serializer,
      boundedAdmissionVerifier(admissionVerifier, dependencies.admissionVerifierTimeoutMilliseconds)
    ),
    ordinaryExecution: createOrdinaryExecutionService(config, serializer)
  };
  let gitIdentity: GitExecutableIdentity | undefined;
  let storageOwner: StorageOwner | undefined;
  let activeBackends = 0;
  const server = createServer((request, response) => {
    const authorityRoute = ordinaryAuthorityRoute(request);
    if (authorityRoute !== undefined && ordinaryAuthority !== undefined) {
      if (serviceAuthenticator?.authenticate(request.headers) !== undefined) return send(response, 403);
      if (gitIdentity === undefined) return send(response, 503);
      void assertGitExecutableIdentity(config.gitExecutable, gitIdentity)
        .then(() => ordinaryAuthority.serve(authorityRoute, request, response))
        .catch(() => send(response, 503));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/identity") {
      if (serviceAuthenticator?.authenticate(request.headers) !== undefined) return send(response, 403);
      const identity = authenticator.authenticate(request.headers);
      if (identity === undefined) return send(response, 401, { "WWW-Authenticate": 'Basic realm="DIM Git"' });
      if (gitIdentity === undefined) return send(response, 503);
      const body = identity.role === "reviewer"
        ? {
            role: identity.role,
            projectId: identity.projectId,
            repositoryIds: identity.repositoryIds,
            reviewerId: identity.reviewerId
          }
        : {
            role: identity.role,
            projectId: identity.projectId,
            repositoryIds: identity.repositoryIds
          };
      void assertGitExecutableIdentity(config.gitExecutable, gitIdentity)
        .then(() => {
          response.writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8"
          });
          response.end(`${JSON.stringify(body)}\n`);
        })
        .catch(() => send(response, 503));
      return;
    }
    const reviewRoute = nativeGitReviewRoute(request);
    if (reviewRoute !== undefined) {
      const identity = serviceAuthenticator?.authenticate(request.headers) ?? authenticator.authenticate(request.headers);
      if (identity === undefined) return send(response, 401, { "WWW-Authenticate": 'Basic realm="DIM Git Review"' });
      if (gitIdentity === undefined) return send(response, 503);
      void assertGitExecutableIdentity(config.gitExecutable, gitIdentity)
        .then(() => serveReviewApi(services, identity, reviewRoute, request, response))
        .catch(() => send(response, 503));
      return;
    }
    const route = nativeGitRoute(request);
    if (route === undefined) return send(response, 404);
    if (serviceAuthenticator?.authenticate(request.headers) !== undefined) return send(response, 403);
    const identity = authenticator.authenticate(request.headers);
    if (identity === undefined) return send(response, 401, { "WWW-Authenticate": 'Basic realm="DIM Git"' });
    const repository = repositories.get(repositoryKey(route.projectId, route.repositoryId));
    if (repository === undefined || !canAccess(identity, route.projectId, route.repositoryId)) return send(response, 404);
    if (route.operation === "read" && identity.role !== "reader" && identity.role !== "writer") return send(response, 403);
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
        eventDispatcher?.start();
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
      await eventDispatcher?.close();
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
      await storageOwner?.release();
      storageOwner = undefined;
    }
  };
}

export async function createConfiguredNativeGitServer(
  input: NativeGitServiceConfig,
  httpClient: AdmissionVerifierHttpClient
): Promise<NativeGitServer> {
  const config = parseNativeGitServiceConfig(input);
  if (config.ordinaryCi === undefined) return createNativeGitServer(config);
  const admissionVerifier = await createOrdinaryAdmissionVerifier({ config: config.ordinaryCi, httpClient });
  const eventHttpClient: NativeEventHttpClient = {
    request(request) {
      const endpoint = new URL(request.endpoint);
      return httpClient.request({
        endpoint: endpoint.origin,
        method: "POST",
        path: endpoint.pathname,
        authorization: request.authorization,
        body: request.body,
        signal: request.signal
      });
    }
  };
  return createNativeGitServerWithDependencies(config, {
    admissionVerifier,
    eventHttpClient
  });
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
