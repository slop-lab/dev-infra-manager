import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { GitExecutableIdentity } from "./repository.js";
import { sendJson, sendNotFound } from "./native-bundle-http.js";
import {
  claimNativeProjectRootImport,
  markNativeProjectRootBundleDurable,
  type NativeGitBundleState
} from "./native-bundle-state.js";
import {
  NativeProjectRootImportConflictError,
  NativeProjectRootImportOwnershipError,
  NativeProjectRootImportStateError,
  type NativeProjectRootImport
} from "./native-project-root-import-state.js";
import { readNativeProjectRegistrationsFromDatabase } from "./native-project-registry-state.js";
import { assertNativeRootObjectFormat } from "./native-root-import-git.js";
import {
  receiveNativeRootBundle,
  type NativeRootImportPrelude
} from "./native-root-import-bundle.js";
import { NativeRootImportBundleError } from "./native-root-import-storage.js";
import { assertConfiguredHumanReviewers } from "./native-human-reviewer-policy.js";
import type { NativeGitBundleConfig } from "./bundle-config.js";
import { parseAuthoritativeImportedRootPolicy } from "./native-imported-root-policy.js";
import { handleNativeProjectRootImportFinalizeHttp } from "./native-project-root-import-finalize-http.js";
import { handleNativeProjectRootImportProofHttp } from "./native-project-root-import-proof-http.js";

type Credential = { readonly username: string; readonly password: string };
type Importer = Credential & { readonly hostId: string };
export type RootImportHttpContext = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly pathname: string;
  readonly activated: boolean;
  readonly expectedGenerationId: string;
  readonly activationTokenDigest: string;
  readonly stateDirectory: string;
  readonly state: NativeGitBundleState;
  readonly importers: readonly Importer[];
  readonly knownCredentials: readonly Credential[];
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly humanReviewers: NativeGitBundleConfig["humanReviewers"];
  readonly acquireImport: () => (() => void) | undefined;
};

type RootImportServiceInput = Omit<
  RootImportHttpContext,
  "request" | "response" | "pathname" | "activated" | "acquireImport"
> & {
  readonly activated: () => boolean;
  readonly available: () => boolean;
};

export type NativeProjectRootImportService = {
  handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean>;
  waitForIdle(): Promise<void>;
};

export function createNativeProjectRootImportService(input: RootImportServiceInput): NativeProjectRootImportService {
  let activeImport = Promise.resolve();
  let importing = false;
  return {
    handle(request, response, pathname) {
      return handleNativeProjectRootImportHttp({
        ...input,
        request,
        response,
        pathname,
        activated: input.activated(),
        acquireImport() {
          if (!input.available() || importing) return undefined;
          importing = true;
          let finish: (() => void) | undefined;
          activeImport = new Promise<void>((resolve) => { finish = resolve; });
          return () => {
            importing = false;
            finish?.();
          };
        }
      });
    },
    waitForIdle() {
      return activeImport;
    }
  };
}

export async function handleNativeProjectRootImportHttp(context: RootImportHttpContext): Promise<boolean> {
  if (await handleNativeProjectRootImportProofHttp(context)) return true;
  if (await handleNativeProjectRootImportFinalizeHttp(context)) return true;
  const identityRequest = context.request.method === "GET"
    && context.pathname === "/v1/operator-root-importer-identity";
  const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/root-import$/.exec(context.pathname);
  if (!identityRequest && (context.request.method !== "POST" || match === null)) return false;
  if (context.importers.length === 0) {
    sendNotFound(context.response);
    return true;
  }
  if (!identityRequest && !context.activated) {
    sendJson(context.response, 503, { error: "native Git business operations require exact generation activation" });
    return true;
  }
  const importer = context.importers.find((candidate) => basicAuthorized(context.request, candidate));
  if (importer === undefined) {
    const known = context.knownCredentials.some((credential) => basicAuthorized(context.request, credential));
    sendJson(context.response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
    return true;
  }
  if (identityRequest) {
    sendJson(context.response, 200, {
      schemaVersion: 1, serviceId: "native-main", role: "operator-root-importer",
      hostId: importer.hostId, generationId: context.expectedGenerationId
    });
    return true;
  }
  const projectId = match?.[1];
  if (projectId === undefined) return false;
  const releaseImport = context.acquireImport();
  if (releaseImport === undefined) {
    sendJson(context.response, 503, { error: "native Git root import is busy" });
    return true;
  }
  let intent: NativeProjectRootImport | undefined;
  try {
    const signal = AbortSignal.timeout(30_000);
    const abortRequest = () => context.request.destroy(new NativeRootImportBundleError("root import request timed out"));
    signal.addEventListener("abort", abortRequest, { once: true });
    const bundle = await receiveNativeRootBundle({
      request: context.request, stateDirectory: context.stateDirectory, projectId,
      gitExecutable: context.gitExecutable, gitIdentity: context.gitIdentity, signal,
      async authorizePrelude(prelude) {
        if (prelude.generationId !== context.expectedGenerationId || prelude.projectId !== projectId) {
          throw new NativeProjectRootImportConflictError(projectId);
        }
        const registration = readNativeProjectRegistrationsFromDatabase(context.state.database)
          .find((entry) => entry.projectId === projectId);
        if (registration === undefined || registration.ownerHostId !== importer.hostId) {
          throw new NativeProjectRootImportOwnershipError();
        }
        if (registration.phase !== "root-prepared") {
          throw new NativeProjectRootImportStateError("native Project root import requires a prepared root");
        }
        await assertNativeRootObjectFormat({
          gitExecutable: context.gitExecutable,
          gitIdentity: context.gitIdentity,
          repository: join(context.stateDirectory, projectId, "root.git"),
          expectedCommit: prelude.expectedCommit,
          signal
        });
        assertConfiguredHumanReviewers(context, parseAuthoritativeImportedRootPolicy(prelude.policy));
        intent = claimNativeProjectRootImport(context.state, prelude.generationId, importer.hostId, {
          serviceId: prelude.serviceId,
          projectId: prelude.projectId,
          rootRepositoryId: prelude.rootRepositoryId,
          protectedRef: prelude.protectedRef,
          expectedCommit: prelude.expectedCommit,
          policy: prelude.policy
        });
        return intent.importNonce;
      }
    }).finally(() => signal.removeEventListener("abort", abortRequest));
    signal.throwIfAborted();
    if (intent === undefined) throw new NativeProjectRootImportStateError("native Project root import intent is missing");
    const durable = markNativeProjectRootBundleDurable(
      context.state, projectId, intent.importNonce, bundle.bundleDigest, bundle.bundleSize
    );
    sendJson(context.response, 200, {
      schemaVersion: 1,
      serviceId: durable.serviceId,
      projectId: durable.projectId,
      rootRepositoryId: durable.rootRepositoryId,
      generationId: durable.generationId,
      importNonce: durable.importNonce,
      protectedRef: durable.protectedRef,
      expectedCommit: durable.expectedCommit,
      policyDigest: durable.policyDigest,
      bundleDigest: durable.bundleDigest,
      bundleSize: durable.bundleSize,
      phase: durable.phase
    });
  } catch (error) {
    if (error instanceof NativeProjectRootImportOwnershipError) {
      sendNotFound(context.response);
      return true;
    }
    if (error instanceof NativeProjectRootImportConflictError) {
      sendJson(context.response, 409, { error: "native Project root import conflicts" });
      return true;
    }
    if (error instanceof NativeRootImportBundleError || error instanceof NativeProjectRootImportStateError) {
      sendJson(context.response, 400, { error: "native Project root import request is invalid" });
      return true;
    }
    throw error;
  } finally {
    releaseImport();
  }
  return true;
}

function basicAuthorized(request: IncomingMessage, credential: Credential): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
