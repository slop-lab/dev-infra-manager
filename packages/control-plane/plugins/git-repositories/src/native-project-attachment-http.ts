import {
  NativeGitProjectAttachmentContractError,
  nativeGitProjectAttachmentMaximumRepositories,
  nativeGitProjectCatalogMaximumProjects,
  parseNativeGitProjectAttachment,
  parseNativeGitProjectCatalog
} from "@slop-lab/dim-contracts-git";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nativeBasicAuthorized } from "./native-basic-auth.js";
import { sendJson, sendNotFound } from "./native-bundle-http.js";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import {
  NativeImportedRootInactiveError,
  NativeImportedRootNotFoundError,
  verifyLiveImportedRepository,
  type LiveImportedRoot
} from "./native-imported-root-verifier.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import { readNativeProjectRootImportsFromDatabase } from "./native-project-root-import-transitions.js";
import { NativeProjectStorageError } from "./native-project-storage.js";
import { NativeRootImportBundleError } from "./native-root-import-storage.js";
import type { RootReadOperationGate } from "./native-root-read-lifecycle.js";
import { RepositoryRefStateError } from "./repository-ref-state.js";
import type { GitExecutableIdentity } from "./repository.js";
import { assertCurrentNativeProjectAttachmentSnapshot } from "./native-project-attachment-snapshot.js";

const attachmentTimeoutMilliseconds = 80_000;
const repositoryProofTimeoutMilliseconds = 30_000;

type Issuer = { readonly hostId: string; readonly username: string; readonly password: string };
type Credential = { readonly username: string; readonly password: string };
export type NativeProjectAttachmentHooks = {
  readonly beforeVerification?: (signal: AbortSignal) => Promise<void>;
  readonly afterVerification?: (signal: AbortSignal) => Promise<void>;
};
type AttachmentHttpContext = {
  readonly activated: boolean;
  readonly activationTokenDigest: string;
  readonly expectedGenerationId: string;
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly issuers: readonly Issuer[];
  readonly hooks?: NativeProjectAttachmentHooks;
  readonly knownCredentials: readonly Credential[];
  readonly operations: RootReadOperationGate;
  readonly serialize: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  readonly signal: AbortSignal;
  readonly state: NativeGitBundleState;
  readonly stateDirectory: string;
};
type AttachmentHttpRequest = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
};
type VerificationSelector = {
  readonly ownerHostId: string;
  readonly projectId: string;
  readonly repositoryId: string;
  readonly signal: AbortSignal;
};

export async function handleNativeProjectAttachmentHttp(
  context: AttachmentHttpContext,
  http: AttachmentHttpRequest
): Promise<boolean> {
  const { request, response, url } = http;
  const projectMatch = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/attachment$/.exec(url.pathname);
  if (request.method !== "GET" || url.search !== "" || (url.pathname !== "/v1/projects" && projectMatch === null)) {
    return false;
  }
  if (context.issuers.length === 0) return sendHandledNotFound(response);
  if (!context.activated) return sendHandledJson(response, 503, "native Git business operations require exact generation activation");
  const issuer = context.issuers.find((candidate) => nativeBasicAuthorized(request, candidate));
  if (issuer === undefined) {
    const known = context.knownCredentials.some((credential) => nativeBasicAuthorized(request, credential));
    return sendHandledJson(response, known ? 403 : 401, known ? "forbidden" : "unauthorized");
  }
  if (request.headers["x-dim-generation-id"] !== context.expectedGenerationId) {
    return sendHandledJson(response, 409, "Project attachment generation conflicts with service startup");
  }
  try {
    if (projectMatch === null) {
      const imported = readNativeProjectRootImportsFromDatabase(context.state.database)
        .filter((entry) => entry.ownerHostId === issuer.hostId && entry.phase === "repository-imported");
      const byProject = new Map<string, Array<(typeof imported)[number]>>();
      for (const entry of imported) {
        const entries = byProject.get(entry.projectId) ?? [];
        entries.push(entry);
        byProject.set(entry.projectId, entries);
      }
      if (byProject.size > nativeGitProjectCatalogMaximumProjects
        || [...byProject.values()].some((entries) => entries.length > nativeGitProjectAttachmentMaximumRepositories)) {
        throw new NativeGitProjectAttachmentContractError("native Git Project catalog exceeds limit");
      }
      sendJson(response, 200, parseNativeGitProjectCatalog({
        schemaVersion: 1,
        serviceId: "native-main",
        generationId: context.expectedGenerationId,
        ownerHostId: issuer.hostId,
        projects: [...byProject].map(([projectId, entries]) => ({ projectId, repositoryCount: entries.length }))
      }));
      return true;
    }
    const projectId = projectMatch[1];
    if (projectId === undefined) return false;
    const release = context.operations.acquire();
    if (release === undefined) {
      if (context.operations.isOpen()) return sendHandledJson(response, 503, "native Git Project attachment service is busy");
      return true;
    }
    const disconnected = new AbortController();
    const abortDisconnected = () => disconnected.abort(new NativeProjectAttachmentRequestError("native Git Project attachment client disconnected"));
    request.once("aborted", abortDisconnected);
    response.once("close", abortDisconnected);
    const signal = AbortSignal.any([
      context.signal,
      disconnected.signal,
      AbortSignal.timeout(attachmentTimeoutMilliseconds)
    ]);
    let snapshotCheck: Promise<void> | undefined;
    try {
      await abortable(context.hooks?.beforeVerification?.(signal) ?? Promise.resolve(), signal);
      const repositories = readNativeProjectRootImportsFromDatabase(context.state.database)
        .filter((entry) => entry.ownerHostId === issuer.hostId && entry.projectId === projectId
          && entry.phase === "repository-imported");
      if (repositories.length === 0) return sendHandledNotFound(response);
      if (repositories.length > nativeGitProjectAttachmentMaximumRepositories) {
        throw new NativeGitProjectAttachmentContractError("native Git Project attachment exceeds limit");
      }
      const verified: LiveImportedRoot[] = [];
      for (const entry of repositories) {
        const repositorySignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(repositoryProofTimeoutMilliseconds)
        ]);
        try {
          verified.push(await verify(context, {
            ownerHostId: issuer.hostId,
            projectId,
            repositoryId: entry.repositoryId,
            signal: repositorySignal
          }));
        } catch (error) {
          if (repositorySignal.aborted && !signal.aborted) {
            throw new NativeProjectAttachmentProofTimeoutError("native Git Project repository proof timed out", { cause: error });
          }
          throw error;
        }
      }
      await abortable(context.hooks?.afterVerification?.(signal) ?? Promise.resolve(), signal);
      signal.throwIfAborted();
      const attachment = parseNativeGitProjectAttachment({
        schemaVersion: 1,
        serviceId: "native-main",
        generationId: context.expectedGenerationId,
        ownerHostId: issuer.hostId,
        projectId,
        repositories: verified.map(({ imported: effective, importReceipt, currentHead }) => ({
          repositoryId: importReceipt.repositoryId,
          importReceipt: {
            schemaVersion: 1,
            serviceId: importReceipt.serviceId,
            projectId: importReceipt.projectId,
            repositoryId: importReceipt.repositoryId,
            generationId: importReceipt.generationId,
            importNonce: importReceipt.importNonce,
            protectedRef: importReceipt.protectedRef,
            expectedCommit: importReceipt.expectedCommit,
            policyDigest: importReceipt.policyDigest,
            bundleDigest: importReceipt.bundleDigest,
            bundleSize: importReceipt.bundleSize,
            resolvedTree: importReceipt.resolvedTree,
            phase: "repository-imported"
          },
          importedPolicy: importReceipt.policy,
          effectivePolicy: effective.policy,
          currentHead
        }))
      });
      snapshotCheck = context.serialize(async () => {
        signal.throwIfAborted();
        assertCurrentNativeProjectAttachmentSnapshot({ database: context.state.database, verified });
      });
      await abortable(snapshotCheck, signal);
      signal.throwIfAborted();
      sendJson(response, 200, attachment);
      return true;
    } catch (error) {
      if (signal.aborted) {
        if (!response.destroyed && !context.signal.aborted && !disconnected.signal.aborted) {
          return sendHandledJson(response, 503, "native Git Project attachment request timed out");
        }
        return true;
      }
      if (error instanceof NativeProjectAttachmentProofTimeoutError) {
        return sendHandledJson(response, 503, "native Git Project attachment repository proof timed out");
      }
      throw error;
    } finally {
      request.off("aborted", abortDisconnected);
      response.off("close", abortDisconnected);
      if (snapshotCheck === undefined) release();
      else void snapshotCheck.then(release, release);
    }
  } catch (error) {
    if (error instanceof NativeImportedRootNotFoundError) return sendHandledNotFound(response);
    if (error instanceof NativeGitProjectAttachmentContractError || error instanceof NativeImportedRootInactiveError
      || error instanceof NativeProjectRootImportStateError || error instanceof NativeProjectStorageError
      || error instanceof NativeRootImportBundleError || error instanceof RepositoryRefStateError) {
      return sendHandledJson(response, 409, "native Project attachment is unavailable");
    }
    throw error;
  }
}

function verify(
  context: AttachmentHttpContext,
  selector: VerificationSelector
): Promise<LiveImportedRoot> {
  return verifyLiveImportedRepository({
    activated: context.activated,
    activationTokenDigest: context.activationTokenDigest,
    expectedGenerationId: context.expectedGenerationId,
    gitExecutable: context.gitExecutable,
    gitIdentity: context.gitIdentity,
    ownerHostId: selector.ownerHostId,
    projectId: selector.projectId,
    repositoryId: selector.repositoryId,
    signal: selector.signal,
    state: context.state,
    stateDirectory: context.stateDirectory
  });
}

function abortable<Result>(operation: Promise<Result>, signal: AbortSignal): Promise<Result> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function sendHandledJson(response: ServerResponse, status: number, error: string): true {
  sendJson(response, status, { error });
  return true;
}

function sendHandledNotFound(response: ServerResponse): true {
  sendNotFound(response);
  return true;
}

class NativeProjectAttachmentRequestError extends Error {
  readonly name = "NativeProjectAttachmentRequestError";
}

class NativeProjectAttachmentProofTimeoutError extends Error {
  readonly name = "NativeProjectAttachmentProofTimeoutError";
}
