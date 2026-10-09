import type { IncomingMessage, ServerResponse } from "node:http";
import { serveGitBackend } from "./backend.js";
import {
  nativeBasicAuthorized,
  nativeBasicCredential,
  type NativeBasicCredential
} from "./native-basic-auth.js";
import {
  NativeGitBundleHttpError,
  readBoundedJson,
  sendEmpty,
  sendJson,
  sendNotFound
} from "./native-bundle-http.js";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import {
  NativeImportedRootInactiveError,
  NativeImportedRootNotFoundError,
  verifyLiveImportedRoot
} from "./native-imported-root-verifier.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import { NativeProjectRootPromotionStateError } from "./native-project-root-promotion-state.js";
import { NativeProjectStorageError } from "./native-project-storage.js";
import { NativeRootImportBundleError } from "./native-root-import-storage.js";
import type { GitExecutableIdentity } from "./repository.js";
import type { NativeGitRoute } from "./routing.js";
import {
  createRootReadLeaseRegistry,
  type RootReadOperationGate,
  type RootReadLeaseScope
} from "./native-root-read-lifecycle.js";

type Credential = NativeBasicCredential;
type Issuer = Credential & { readonly hostId: string };
export type NativeProjectRootReadHooks = {
  readonly beforeVerification?: () => Promise<void>;
  readonly backendStarted?: () => void;
};
type RootReadServiceInput = {
  readonly activationTokenDigest: string;
  readonly expectedGenerationId: string;
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly issuers: readonly Issuer[];
  readonly knownCredentials: readonly Credential[];
  readonly now: () => number;
  readonly operations: RootReadOperationGate;
  readonly state: NativeGitBundleState;
  readonly stateDirectory: string;
  readonly activated: () => boolean;
  readonly hooks?: NativeProjectRootReadHooks;
};

export type NativeProjectRootReadService = {
  close(): void;
  handleLeaseRequest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
  serveGit(request: IncomingMessage, response: ServerResponse, route: NativeGitRoute): Promise<void>;
};

export function createNativeProjectRootReadService(input: RootReadServiceInput): NativeProjectRootReadService {
  const leases = createRootReadLeaseRegistry(input.now);
  const operations = input.operations;
  return {
    close() {
      leases.clear();
    },
    async handleLeaseRequest(request, response, url) {
      const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/root-read-leases$/
        .exec(url.pathname);
      if (match === null) return false;
      if (request.method !== "POST" || url.search !== "") {
        sendNotFound(response);
        return true;
      }
      const projectId = match[1];
      if (projectId === undefined) return false;
      if (input.issuers.length === 0) {
        sendNotFound(response);
        return true;
      }
      if (!input.activated()) {
        sendJson(response, 503, { error: "native Git business operations require exact generation activation" });
        return true;
      }
      const issuer = input.issuers.find((candidate) => nativeBasicAuthorized(request, candidate));
      if (issuer === undefined) {
        const known = input.knownCredentials.some((credential) => nativeBasicAuthorized(request, credential));
        sendJson(response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
        return true;
      }
      const release = operations.acquire();
      if (release === undefined) {
        if (operations.isOpen()) sendJson(response, 503, { error: "native Git root read service is busy" });
        return true;
      }
      let generationId: string;
      try {
        try {
          generationId = parseLeaseRequest(await readBoundedJson(request));
        } catch (error) {
          if (error instanceof NativeGitBundleHttpError || error instanceof NativeProjectRootImportStateError) {
            if (operations.isOpen()) sendJson(response, 400, { error: "native Project root read lease request is invalid" });
            return true;
          }
          throw error;
        }
        if (!operations.isOpen()) return true;
        if (generationId !== input.expectedGenerationId) {
          sendJson(response, 409, { error: "root read lease generation conflicts with service startup" });
          return true;
        }
        await input.hooks?.beforeVerification?.();
        if (!operations.isOpen()) return true;
        try {
          await verify(input, projectId, issuer.hostId);
        } catch (error) {
          if (!operations.isOpen()) return true;
          return sendVerificationFailure(response, error);
        }
        if (!operations.isOpen()) return true;
        const lease = leases.issue({
          generationId: input.expectedGenerationId,
          ownerHostId: issuer.hostId,
          projectId
        });
        if (lease === undefined) {
          sendJson(response, 503, { error: "native Git root read lease capacity is exhausted" });
          return true;
        }
        sendJson(response, 201, {
          schemaVersion: 1,
          serviceId: "native-main",
          projectId,
          rootRepositoryId: "root",
          generationId: input.expectedGenerationId,
          username: lease.username,
          password: lease.password,
          expiresAt: lease.expiresAt
        });
        return true;
      } finally {
        release();
      }
    },
    async serveGit(request, response, route) {
      const credential = nativeBasicCredential(request);
      const lease = credential === undefined ? undefined : leases.authenticate(credential);
      if (lease === undefined || lease.generationId !== input.expectedGenerationId) {
        const known = input.knownCredentials.some((candidate) => nativeBasicAuthorized(request, candidate))
           || input.issuers.some((candidate) => nativeBasicAuthorized(request, candidate));
        sendEmpty(response, known ? 403 : 401, { "WWW-Authenticate": 'Basic realm="DIM Git"' });
        return;
      }
      if (route.projectId !== lease.projectId || route.repositoryId !== "root") {
        sendNotFound(response);
        return;
      }
      if (route.operation !== "read") {
        sendEmpty(response, 403);
        return;
      }
      const release = operations.acquire();
      if (release === undefined) {
        if (operations.isOpen()) sendEmpty(response, 503);
        return;
      }
      try {
        await input.hooks?.beforeVerification?.();
        if (!operations.isOpen()) return;
        try {
          await verify(input, route.projectId, lease.ownerHostId);
        } catch (error) {
          if (operations.isOpen()) sendVerificationFailure(response, error);
          return;
        }
        if (!operations.isOpen()) return;
        const currentLease = credential === undefined ? undefined : leases.authenticate(credential);
        if (currentLease === undefined || !leaseMatchesRoute(currentLease, route, input.expectedGenerationId)) {
          sendEmpty(response, 401, { "WWW-Authenticate": 'Basic realm="DIM Git"' });
          return;
        }
        input.hooks?.backendStarted?.();
        await serveGitBackend({
          config: { gitExecutable: input.gitExecutable, storageRoot: input.stateDirectory },
          identity: { role: "reader", username: "root-read-lease" },
          route,
          request,
          response
        });
      } finally {
        release();
      }
    }
  };
}

function leaseMatchesRoute(lease: RootReadLeaseScope, route: NativeGitRoute, generationId: string): boolean {
  return lease.generationId === generationId && lease.projectId === route.projectId && route.repositoryId === "root";
}

function verify(input: RootReadServiceInput, projectId: string, ownerHostId: string) {
  return verifyLiveImportedRoot({
    activated: input.activated(),
    activationTokenDigest: input.activationTokenDigest,
    expectedGenerationId: input.expectedGenerationId,
    gitExecutable: input.gitExecutable,
    gitIdentity: input.gitIdentity,
    ownerHostId,
    projectId,
    state: input.state,
    stateDirectory: input.stateDirectory
  });
}

function sendVerificationFailure(response: ServerResponse, error: unknown): true {
  if (error instanceof NativeImportedRootInactiveError) {
    sendJson(response, 503, { error: "native Git business operations require exact generation activation" });
    return true;
  }
  if (error instanceof NativeImportedRootNotFoundError) {
    sendNotFound(response);
    return true;
  }
  if (error instanceof NativeProjectRootImportStateError || error instanceof NativeProjectRootPromotionStateError
    || error instanceof NativeRootImportBundleError
    || error instanceof NativeProjectStorageError) {
    sendJson(response, 409, { error: "native Project imported root proof is unavailable" });
    return true;
  }
  throw error;
}

function parseLeaseRequest(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 2
    || Reflect.get(value, "schemaVersion") !== 1 || typeof Reflect.get(value, "generationId") !== "string"
    || !/^[0-9a-f]{64}$/.test(Reflect.get(value, "generationId"))) {
    throw new NativeProjectRootImportStateError("native Project root read lease request is invalid");
  }
  return Reflect.get(value, "generationId");
}
