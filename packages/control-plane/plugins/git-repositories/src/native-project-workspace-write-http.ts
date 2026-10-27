import type { IncomingMessage, ServerResponse } from "node:http";
import {
  nativeBasicAuthorized,
  nativeBasicCredential,
  type NativeBasicCredential
} from "./native-basic-auth.js";
import {
  NativeGitBundleHttpError,
  readBoundedJson,
  sendJson,
  sendNotFound
} from "./native-bundle-http.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import type { RootReadOperationGate } from "./native-root-read-lifecycle.js";
import type { NativeGitRoute } from "./routing.js";
import {
  createWorkspaceWriteLeaseRegistry,
} from "./native-workspace-write-lifecycle.js";
import {
  parseWorkspaceWriteLeaseRequest,
  verifyAuthoritativeWorkspaceRoot,
  type WorkspaceWriteLeaseRequest,
  type WorkspaceWriteVerificationInput
} from "./native-workspace-write-proof.js";
import type { WorkspaceWriteLeaseScope } from "./native-workspace-write-lifecycle.js";
import {
  sendWorkspaceWriteVerificationFailure,
  serveNativeWorkspaceWriteGit
} from "./native-workspace-write-serving.js";
import type { RepositoryExtensionContext } from "./plugin-api.js";

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
  readonly mutate: RepositoryExtensionContext["mutate"];
  readonly read: RepositoryExtensionContext["read"];
};

export type NativeProjectWorkspaceWriteService = {
  close(): void;
  authorizeWorkspaceLease(request: IncomingMessage, selector: { readonly projectId: string; readonly repositoryId: string }): Promise<WorkspaceWriteLeaseScope>;
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
    async authorizeWorkspaceLease(request, selector) {
      const credential = nativeBasicCredential(request);
      const lease = credential === undefined ? undefined : leases.authenticate(credential);
      if (lease === undefined || lease.generationId !== input.expectedGenerationId) {
        throw new WorkspaceWriteAuthorizationError(401, "workspace lease is unauthorized");
      }
      if (lease.projectId !== selector.projectId || lease.repositoryId !== selector.repositoryId) {
        throw new WorkspaceWriteAuthorizationError(404, "workspace repository scope was not found");
      }
      if (!input.activated() || !input.operations.isOpen()) {
        throw new WorkspaceWriteAuthorizationError(503, "workspace repository access is unavailable");
      }
      const release = input.operations.acquire();
      if (release === undefined) throw new WorkspaceWriteAuthorizationError(503, "workspace repository access is busy");
      try {
        await verifyAuthoritativeWorkspaceRoot(input, selector.projectId, selector.repositoryId, lease.ownerHostId);
        const current = credential === undefined ? undefined : leases.authenticate(credential);
        if (current === undefined || current.generationId !== input.expectedGenerationId
          || current.projectId !== selector.projectId || current.repositoryId !== selector.repositoryId
          || current.workspaceId !== lease.workspaceId || current.ownerHostId !== lease.ownerHostId) {
          throw new WorkspaceWriteAuthorizationError(401, "workspace lease expired during authorization");
        }
        return current;
      } catch (error) {
        if (error instanceof WorkspaceWriteAuthorizationError) throw error;
        throw new WorkspaceWriteAuthorizationError(409, "workspace repository proof is stale", { cause: error });
      } finally { release(); }
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
      const handlerEntry = performance.now();
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
          if (input.operations.isOpen()) sendWorkspaceWriteVerificationFailure(response, error);
          return true;
        }
        if (!input.operations.isOpen()) return true;
        const preIssueMilliseconds = Math.floor(performance.now() - handlerEntry);
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
          schemaVersion: 2,
          serviceId: "native-main",
          projectId,
          repositoryId: lease.repositoryId,
          generationId: lease.generationId,
          workspaceId: lease.workspaceId,
          username: lease.username,
          password: lease.password,
          issuedAt: lease.issuedAt,
          expiresAt: lease.expiresAt,
          preIssueMilliseconds
        });
        return true;
      } finally {
        release();
      }
    },
    async serveGit(request, response, route) {
      return serveNativeWorkspaceWriteGit({
        ...input,
        authenticateLease: leases.authenticate,
        ...(input.hooks?.beforeVerification === undefined
          ? {}
          : { beforeVerification: input.hooks.beforeVerification })
      }, { request, response, route });
    }
  };
}

export class WorkspaceWriteAuthorizationError extends Error {
  constructor(readonly status: 401 | 404 | 409 | 503, message: string, options?: ErrorOptions) { super(message, options); }
}
