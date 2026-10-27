import type { IncomingMessage, ServerResponse } from "node:http";
import { serveGitBackend } from "./backend.js";
import { workspaceProtectedRefs } from "./candidate-ref-policy.js";
import { nativeBasicCredential } from "./native-basic-auth.js";
import { sendEmpty, sendJson, sendNotFound } from "./native-bundle-http.js";
import {
  NativeImportedRootInactiveError,
  NativeImportedRootNotFoundError,
  type LiveImportedRoot
} from "./native-imported-root-verifier.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import { NativeProjectStorageError } from "./native-project-storage.js";
import {
  changedNativeProposalRefs,
  readNativeProposalRefs,
  type NativeProposalRefSnapshot
} from "./native-proposal-reconciler.js";
import { NativeRootImportBundleError } from "./native-root-import-storage.js";
import type { RootReadOperationGate } from "./native-root-read-lifecycle.js";
import type { WorkspaceWriteLeaseRegistry } from "./native-workspace-write-lifecycle.js";
import {
  verifyAuthoritativeWorkspaceRoot,
  workspaceWriteLeaseMatchesRoute,
  type WorkspaceWriteVerificationInput
} from "./native-workspace-write-proof.js";
import type { RepositoryExtensionContext } from "./plugin-api.js";
import { RepositoryRefStateError } from "./repository-ref-state.js";
import { assertGitExecutableIdentity, assertRegisteredRepository } from "./repository.js";
import type { NativeGitRoute } from "./routing.js";

type NativeWorkspaceWriteServingInput = WorkspaceWriteVerificationInput & {
  readonly authenticateLease: WorkspaceWriteLeaseRegistry["authenticate"];
  readonly operations: RootReadOperationGate;
  readonly beforeVerification?: () => Promise<void>;
  readonly reconcileProposalRefs: (projectId: string, repositoryId: string, proposalRefs: readonly string[]) => Promise<void>;
  readonly mutate: RepositoryExtensionContext["mutate"];
  readonly read: RepositoryExtensionContext["read"];
};

type NativeWorkspaceWriteServingRequest = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly route: NativeGitRoute;
};

export async function serveNativeWorkspaceWriteGit(
  input: NativeWorkspaceWriteServingInput,
  serving: NativeWorkspaceWriteServingRequest
): Promise<boolean> {
  const credential = nativeBasicCredential(serving.request);
  const lease = credential === undefined ? undefined : input.authenticateLease(credential);
  if (lease === undefined || lease.generationId !== input.expectedGenerationId) return false;
  if (!workspaceWriteLeaseMatchesRoute(lease, serving.route, input.expectedGenerationId)) {
    sendNotFound(serving.response);
    return true;
  }
  const receive = serving.request.method === "POST" && serving.route.pathInfo.endsWith("/git-receive-pack");
  const run = receive
    ? <Result>(operation: () => Promise<Result>) => input.mutate(serving.route, operation)
    : input.read;
  await run(async () => {
    await input.beforeVerification?.();
    if (!input.operations.isOpen()) return true;
    let verified: LiveImportedRoot;
    try {
      verified = await verifyAuthoritativeWorkspaceRoot(
        input,
        serving.route.projectId,
        serving.route.repositoryId,
        lease.ownerHostId
      );
      await assertGitExecutableIdentity(input.gitExecutable, input.gitIdentity);
      await assertRegisteredRepository({
        gitExecutable: input.gitExecutable,
        storageRoot: input.stateDirectory
      }, { projectId: serving.route.projectId, repositoryId: serving.route.repositoryId });
    } catch (error) {
      if (input.operations.isOpen()) sendWorkspaceWriteVerificationFailure(serving.response, error);
      return;
    }
    if (!input.operations.isOpen()) return true;
    const currentLease = credential === undefined ? undefined : input.authenticateLease(credential);
    if (currentLease === undefined
      || !workspaceWriteLeaseMatchesRoute(currentLease, serving.route, input.expectedGenerationId)) {
      sendEmpty(serving.response, 401, { "WWW-Authenticate": 'Basic realm="DIM Git"' });
      return true;
    }
    let before: NativeProposalRefSnapshot | undefined;
    if (receive) {
      before = await readNativeProposalRefs(input, serving.route.projectId, serving.route.repositoryId, lease.workspaceId);
    }
    await serveGitBackend({
      config: { gitExecutable: input.gitExecutable, storageRoot: input.stateDirectory },
      identity: { role: "writer", username: "workspace-write-lease", workspaceId: lease.workspaceId },
      route: serving.route,
      request: serving.request,
      response: serving.response,
      protectedRefs: workspaceProtectedRefs(verified.imported.policy),
      ...(before === undefined ? {} : { afterSuccessfulWrite: async () => {
        const after = await readNativeProposalRefs(
          input,
          serving.route.projectId,
          serving.route.repositoryId,
          lease.workspaceId
        );
        await input.reconcileProposalRefs(
          serving.route.projectId,
          serving.route.repositoryId,
          changedNativeProposalRefs(before, after)
        );
      } })
    });
  });
  return true;
}

export function sendWorkspaceWriteVerificationFailure(response: ServerResponse, error: unknown): void {
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
