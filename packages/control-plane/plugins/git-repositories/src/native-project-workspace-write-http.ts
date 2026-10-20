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
import { NativeImportedRootInactiveError, NativeImportedRootNotFoundError } from "./native-imported-root-verifier.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import { RepositoryRefStateError } from "./repository-ref-state.js";
import { NativeProjectStorageError } from "./native-project-storage.js";
import { NativeRootImportBundleError } from "./native-root-import-storage.js";
import type { RootReadOperationGate } from "./native-root-read-lifecycle.js";
import {
  assertGitExecutableIdentity,
  assertRegisteredRepository,
  type GitExecutableIdentity
} from "./repository.js";
import type { NativeGitRoute } from "./routing.js";
import {
  changedNativeProposalRefs,
  readNativeProposalRefs,
  type NativeProposalRefSnapshot
} from "./native-proposal-reconciler.js";
import {
  createWorkspaceWriteLeaseRegistry,
} from "./native-workspace-write-lifecycle.js";
import {
  parseWorkspaceWriteLeaseRequest,
  verifyAuthoritativeWorkspaceRoot,
  workspaceWriteLeaseMatchesRoute,
  type WorkspaceWriteLeaseRequest,
  type WorkspaceWriteVerificationInput
} from "./native-workspace-write-proof.js";

type Issuer = NativeBasicCredential & { readonly hostId: string };
export type NativeProjectWorkspaceWriteHooks = {
  readonly beforeVerification?: () => Promise<void>;
};
type WorkspaceWriteServiceInput = WorkspaceWriteVerificationInput & {
  readonly issuers: readonly Issuer[];
  readonly knownCredentials: readonly NativeBasicCredential[];
  readonly now: () => number;
  readonly operations: RootReadOperationGate;
  readonly hooks?: NativeProjectWorkspaceWriteHooks;
  readonly reconcileProposalRefs: (projectId: string, repositoryId: string, proposalRefs: readonly string[]) => Promise<void>;
  readonly serializeReceive: <Result>(operation: () => Promise<Result>) => Promise<Result>;
};

export type NativeProjectWorkspaceWriteService = {
  close(): void;
  handleLeaseRequest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
  serveGit(request: IncomingMessage, response: ServerResponse, route: NativeGitRoute): Promise<boolean>;
};

export function createNativeProjectWorkspaceWriteService(
  input: WorkspaceWriteServiceInput
): NativeProjectWorkspaceWriteService {
  const leases = createWorkspaceWriteLeaseRegistry(input.now);
  return {
    close() {
      leases.clear();
    },
    async handleLeaseRequest(request, response, url) {
      const identityPath = "/v1/operator-workspace-write-issuer-identity";
      if (url.pathname === identityPath) {
        if (request.method !== "GET" || url.search !== "") {
          sendNotFound(response);
          return true;
        }
        if (input.issuers.length === 0) {
          sendNotFound(response);
          return true;
        }
       const issuer = input.issuers.find((candidate) => nativeBasicAuthorized(request, candidate));
        if (issuer === undefined) {
          const known = input.knownCredentials.some((credential) => nativeBasicAuthorized(request, credential));
          sendJson(response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
          return true;
        }
        sendJson(response, 200, {
          schemaVersion: 1, serviceId: "native-main", role: "operator-workspace-write-issuer",
          hostId: issuer.hostId, generationId: input.expectedGenerationId
        });
        return true;
      }
      const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/repositories\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/workspace-write-leases$/
        .exec(url.pathname);
      if (match === null) return false;
      if (request.method !== "POST" || url.search !== "") {
        sendNotFound(response);
        return true;
      }
      const projectId = match[1];
      const repositoryId = match[2];
      if (projectId === undefined || repositoryId === undefined) return false;
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
      const release = input.operations.acquire();
      if (release === undefined) {
        if (input.operations.isOpen()) sendJson(response, 503, { error: "native Git transport service is busy" });
        return true;
      }
      try {
        let leaseRequest: WorkspaceWriteLeaseRequest;
        try {
          leaseRequest = parseWorkspaceWriteLeaseRequest(await readBoundedJson(request));
        } catch (error) {
          if (error instanceof NativeGitBundleHttpError || error instanceof NativeProjectRootImportStateError) {
            if (input.operations.isOpen()) {
              sendJson(response, 400, { error: "native Project workspace write lease request is invalid" });
            }
            return true;
          }
          throw error;
        }
        if (!input.operations.isOpen()) return true;
        if (leaseRequest.generationId !== input.expectedGenerationId || leaseRequest.repositoryId !== repositoryId) {
          sendJson(response, 409, { error: "workspace write lease generation conflicts with service startup" });
          return true;
        }
        await input.hooks?.beforeVerification?.();
        if (!input.operations.isOpen()) return true;
        try {
          await verifyAuthoritativeWorkspaceRoot(input, projectId, repositoryId, issuer.hostId);
        } catch (error) {
          if (input.operations.isOpen()) sendVerificationFailure(response, error);
          return true;
        }
        if (!input.operations.isOpen()) return true;
        const lease = leases.issue({
          generationId: input.expectedGenerationId,
          ownerHostId: issuer.hostId,
          projectId,
          repositoryId: leaseRequest.repositoryId,
          workspaceId: leaseRequest.workspaceId
        });
        if (lease === undefined) {
          sendJson(response, 503, { error: "native Git workspace write lease capacity is exhausted" });
          return true;
        }
        sendJson(response, 201, {
          schemaVersion: 1,
          serviceId: "native-main",
          projectId,
          repositoryId: lease.repositoryId,
          generationId: lease.generationId,
          workspaceId: lease.workspaceId,
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
      if (lease === undefined || lease.generationId !== input.expectedGenerationId) return false;
      if (!workspaceWriteLeaseMatchesRoute(lease, route, input.expectedGenerationId)) {
        sendNotFound(response);
        return true;
      }
      await input.serializeReceive(async () => {
        await input.hooks?.beforeVerification?.();
        if (!input.operations.isOpen()) return true;
        try {
          await verifyAuthoritativeWorkspaceRoot(input, route.projectId, route.repositoryId, lease.ownerHostId);
          await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
          await assertRegisteredRepository({
            gitExecutable: input.gitExecutable,
            storageRoot: input.stateDirectory
          }, { projectId: route.projectId, repositoryId: route.repositoryId });
        } catch (error) {
          if (input.operations.isOpen()) sendVerificationFailure(response, error);
          return;
        }
        if (!input.operations.isOpen()) return true;
        const currentLease = credential === undefined ? undefined : leases.authenticate(credential);
        if (currentLease === undefined
          || !workspaceWriteLeaseMatchesRoute(currentLease, route, input.expectedGenerationId)) {
          sendEmpty(response, 401, { "WWW-Authenticate": 'Basic realm="DIM Git"' });
          return true;
        }
        let before: NativeProposalRefSnapshot | undefined;
        if (request.method === "POST" && route.pathInfo.endsWith("/git-receive-pack")) {
          before = await readNativeProposalRefs(input, route.projectId, route.repositoryId, lease.workspaceId);
        }
        await serveGitBackend({
          config: { gitExecutable: input.gitExecutable, storageRoot: input.stateDirectory },
          identity: { role: "writer", username: "workspace-write-lease", workspaceId: lease.workspaceId },
          route,
          request,
          response,
          ...(before === undefined ? {} : { afterSuccessfulWrite: async () => {
            const after = await readNativeProposalRefs(input, route.projectId, route.repositoryId, lease.workspaceId);
            await input.reconcileProposalRefs(route.projectId, route.repositoryId, changedNativeProposalRefs(before, after));
          } })
        });
      });
      return true;
    }
  };
}

function sendVerificationFailure(response: ServerResponse, error: unknown): void {
  if (error instanceof NativeImportedRootInactiveError) {
    sendJson(response, 503, { error: "native Git business operations require exact generation activation" });
    return;
  }
  if (error instanceof NativeImportedRootNotFoundError) {
    sendNotFound(response);
    return;
  }
  if (error instanceof NativeProjectRootImportStateError || error instanceof RepositoryRefStateError
    || error instanceof NativeRootImportBundleError
    || error instanceof NativeProjectStorageError) {
    sendJson(response, 409, { error: "native Project imported root proof is unavailable" });
    return;
  }
  throw error;
}
