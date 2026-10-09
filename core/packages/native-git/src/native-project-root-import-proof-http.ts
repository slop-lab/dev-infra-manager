import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { sendJson, sendNotFound } from "./native-bundle-http.js";
import { exactActivationIsBound } from "./native-bundle-activation.js";
import type { RootImportHttpContext } from "./native-project-root-import-http.js";
import { NativeProjectRootImportStateError } from "./native-project-root-import-codec.js";
import { NativeProjectRootPromotionStateError } from "./native-project-root-promotion-state.js";
import { NativeProjectStorageError } from "./native-project-storage.js";
import { NativeRootImportBundleError } from "./native-root-import-storage.js";
import {
  NativeImportedRootInactiveError,
  NativeImportedRootNotFoundError,
  verifyLiveImportedRoot
} from "./native-imported-root-verifier.js";

type Credential = { readonly username: string; readonly password: string };

export async function handleNativeProjectRootImportProofHttp(
  context: RootImportHttpContext
): Promise<boolean> {
  const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/root-import\/proof$/
    .exec(context.pathname);
  if (context.request.method !== "GET" || match === null) return false;
  const projectId = match[1];
  if (projectId === undefined) return false;
  if (context.importers.length === 0) {
    sendNotFound(context.response);
    return true;
  }
  if (!context.activated || !exactActivationIsBound(
    context.state, context.expectedGenerationId, context.activationTokenDigest
  )) {
    sendJson(context.response, 503, { error: "native Git business operations require exact generation activation" });
    return true;
  }
  const importer = context.importers.find((candidate) => basicAuthorized(context.request, candidate));
  if (importer === undefined) {
    const known = context.knownCredentials.some((credential) => basicAuthorized(context.request, credential));
    sendJson(context.response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
    return true;
  }
  try {
    const { imported, currentHead } = await verifyLiveImportedRoot({
      activated: context.activated,
      activationTokenDigest: context.activationTokenDigest,
      expectedGenerationId: context.expectedGenerationId,
      gitExecutable: context.gitExecutable,
      gitIdentity: context.gitIdentity,
      ownerHostId: importer.hostId,
      projectId,
      state: context.state,
      stateDirectory: context.stateDirectory
    });
    sendJson(context.response, 200, {
      schemaVersion: 3,
      servingGenerationId: context.expectedGenerationId,
      ownerHostId: imported.ownerHostId,
      importReceipt: {
        schemaVersion: 1,
        serviceId: imported.serviceId,
        projectId: imported.projectId,
        rootRepositoryId: imported.rootRepositoryId,
        generationId: imported.generationId,
        importNonce: imported.importNonce,
        protectedRef: imported.protectedRef,
        expectedCommit: imported.expectedCommit,
        resolvedTree: imported.resolvedTree,
        policyDigest: imported.policyDigest,
        bundleDigest: imported.bundleDigest,
        bundleSize: imported.bundleSize,
        phase: imported.phase
      },
      currentHead
    });
  } catch (error) {
    if (error instanceof NativeImportedRootInactiveError) {
      sendJson(context.response, 503, { error: "native Git business operations require exact generation activation" });
      return true;
    }
    if (error instanceof NativeImportedRootNotFoundError) {
      sendNotFound(context.response);
      return true;
    }
    if (error instanceof NativeProjectRootImportStateError || error instanceof NativeRootImportBundleError
      || error instanceof NativeProjectRootPromotionStateError || error instanceof NativeProjectStorageError) {
      sendJson(context.response, 409, { error: "native Project imported root proof is unavailable" });
      return true;
    }
    throw error;
  }
  return true;
}

function basicAuthorized(request: IncomingMessage, credential: Credential): boolean {
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
