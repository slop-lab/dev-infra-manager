import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { NativeGitBundleHttpError, readBoundedJson, sendJson, sendNotFound } from "./native-bundle-http.js";
import { finalizeNativeProjectRootImport } from "./native-root-import-finalization.js";
import {
  NativeProjectRootImportConflictError,
  NativeProjectRootImportOwnershipError,
  NativeProjectRootImportStateError,
  parseNativeProjectRootImportFinalizeSelector
} from "./native-project-root-import-codec.js";
import type { RootImportHttpContext } from "./native-project-root-import-http.js";
import { readNativeProjectRegistrationsFromDatabase } from "./native-project-registry-state.js";
import { NativeRootImportBundleError } from "./native-root-import-storage.js";

type Credential = { readonly username: string; readonly password: string };

export async function handleNativeProjectRootImportFinalizeHttp(
  context: RootImportHttpContext
): Promise<boolean> {
  const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/root-import\/finalize$/
    .exec(context.pathname);
  if (context.request.method !== "POST" || match === null) return false;
  const projectId = match[1];
  if (projectId === undefined) return false;
  if (context.importers.length === 0) {
    sendNotFound(context.response);
    return true;
  }
  if (!context.activated) {
    sendJson(context.response, 503, { error: "native Git business operations require exact generation activation" });
    return true;
  }
  const importer = context.importers.find((candidate) => basicAuthorized(context.request, candidate));
  if (importer === undefined) {
    const known = context.knownCredentials.some((credential) => basicAuthorized(context.request, credential));
    sendJson(context.response, known ? 403 : 401, { error: known ? "forbidden" : "unauthorized" });
    return true;
  }
  const registration = readNativeProjectRegistrationsFromDatabase(context.state.database)
    .find((entry) => entry.projectId === projectId);
  if (registration === undefined || registration.ownerHostId !== importer.hostId) {
    sendNotFound(context.response);
    return true;
  }
  if (registration.phase !== "root-prepared") {
    sendJson(context.response, 409, { error: "native Project root import conflicts" });
    return true;
  }
  const releaseImport = context.acquireImport();
  if (releaseImport === undefined) {
    sendJson(context.response, 503, { error: "native Git root import is busy" });
    return true;
  }
  try {
    const selector = parseNativeProjectRootImportFinalizeSelector(await readBoundedJson(context.request));
    if (selector.generationId !== context.expectedGenerationId) {
      throw new NativeProjectRootImportConflictError(projectId);
    }
    const finalized = await finalizeNativeProjectRootImport({
      state: context.state,
      stateDirectory: context.stateDirectory,
      projectId,
      ownerHostId: importer.hostId,
      selector,
      gitExecutable: context.gitExecutable,
      gitIdentity: context.gitIdentity,
      signal: AbortSignal.timeout(30_000)
    });
    if (finalized.phase !== "root-imported") {
      throw new NativeProjectRootImportStateError("native Project root import did not finalize");
    }
    sendJson(context.response, 200, {
      schemaVersion: 1,
      serviceId: finalized.serviceId,
      projectId: finalized.projectId,
      rootRepositoryId: finalized.rootRepositoryId,
      generationId: finalized.generationId,
      importNonce: finalized.importNonce,
      protectedRef: finalized.protectedRef,
      expectedCommit: finalized.expectedCommit,
      policyDigest: finalized.policyDigest,
      bundleDigest: finalized.bundleDigest,
      bundleSize: finalized.bundleSize,
      resolvedTree: finalized.resolvedTree,
      phase: finalized.phase
    });
  } catch (error) {
    if (error instanceof NativeProjectRootImportOwnershipError) {
      sendNotFound(context.response);
      return true;
    }
    if (error instanceof NativeProjectRootImportConflictError || error instanceof NativeRootImportBundleError) {
      sendJson(context.response, 409, { error: "native Project root import conflicts" });
      return true;
    }
    if (error instanceof NativeProjectRootImportStateError || error instanceof NativeGitBundleHttpError) {
      sendJson(context.response, 400, { error: "native Project root import finalize request is invalid" });
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
