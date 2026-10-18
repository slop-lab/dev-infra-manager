import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { nativeBasicCredential, type NativeBasicCredential } from "./native-basic-auth.js";
import { NativeGitBundleHttpError, readBoundedJson, sendJson, sendNotFound } from "./native-bundle-http.js";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import { verifyLiveImportedRoot } from "./native-imported-root-verifier.js";
import { assertNativeRootSelectionFastForward } from "./native-root-import-proof-git.js";
import type { GitExecutableIdentity } from "./repository.js";

type ReadinessIssuer = NativeBasicCredential & { readonly hostId: string };

type NativeProjectReadinessInput = {
  readonly activated: () => boolean;
  readonly activationTokenDigest: string;
  readonly expectedGenerationId: string;
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly issuers: readonly ReadinessIssuer[];
  readonly state: NativeGitBundleState;
  readonly stateDirectory: string;
};

export async function handleNativeProjectReadinessHttp(
  input: NativeProjectReadinessInput,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = /^\/v1\/projects\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/workspace-readiness$/
    .exec(url.pathname);
  if (match === null) return false;
  if (request.method !== "POST" || url.search !== "") {
    sendNotFound(response);
    return true;
  }
  const credential = nativeBasicCredential(request);
  const issuer = credential === undefined ? undefined : input.issuers.find((candidate) =>
    credential.username === candidate.username && secretEqual(credential.password, candidate.password));
  if (issuer === undefined) {
    sendJson(response, 401, { error: "unauthorized" });
    return true;
  }
  let body: ReadinessRequest;
  try {
    body = parseReadinessRequest(await readBoundedJson(request));
  } catch (error) {
    if (error instanceof NativeGitBundleHttpError || error instanceof NativeProjectReadinessError) {
      sendJson(response, 400, { error: "native Project workspace readiness request is invalid" });
      return true;
    }
    throw error;
  }
  const projectId = match[1];
  if (projectId === undefined || body.generationId !== input.expectedGenerationId || !input.activated()) {
    sendJson(response, 409, { error: "native Project workspace readiness is unavailable" });
    return true;
  }
  try {
    const live = await verifyLiveImportedRoot({
      activated: input.activated(), activationTokenDigest: input.activationTokenDigest,
      expectedGenerationId: input.expectedGenerationId, gitExecutable: input.gitExecutable,
      gitIdentity: input.gitIdentity, ownerHostId: issuer.hostId, projectId,
      state: input.state, stateDirectory: input.stateDirectory
    });
    const policy = live.imported.policy;
    if (body.repositoryId !== live.imported.rootRepositoryId
      || body.protectedRef !== live.currentHead.protectedRef || body.policyRevision !== policy.policyRevision
      || body.requiredReviewRevision !== policy.requiredReviewRevision
      || body.requiredJobSetRevision !== policy.requiredJobSetRevision) {
      throw new NativeProjectReadinessError();
    }
    await assertNativeRootSelectionFastForward({
      gitExecutable: input.gitExecutable, gitIdentity: input.gitIdentity, repository: live.repository,
      protectedRef: live.currentHead.protectedRef, importedCommit: live.imported.expectedCommit,
      importedTree: live.imported.resolvedTree, currentCommit: live.currentHead.commit,
      currentTree: live.currentHead.tree, signal: AbortSignal.timeout(30_000)
    }, body.rootCommit, body.rootTree);
    sendJson(response, 200, {
      schemaVersion: 1, serviceId: "native-main", ownerHostId: issuer.hostId, projectId,
      repositoryId: "root", generationId: input.expectedGenerationId,
      protectedRef: live.currentHead.protectedRef, commit: live.currentHead.commit, tree: live.currentHead.tree,
      policyRevision: policy.policyRevision, requiredReviewRevision: policy.requiredReviewRevision,
      requiredJobSetRevision: policy.requiredJobSetRevision
    });
  } catch (error) {
    if (error instanceof NativeProjectReadinessError) {
      sendJson(response, 409, { error: "native Project workspace readiness proof conflicts with registered state" });
      return true;
    }
    sendJson(response, 409, { error: "native Project workspace readiness proof is unavailable" });
  }
  return true;
}

type ReadinessRequest = {
  readonly generationId: string;
  readonly repositoryId: "root";
  readonly protectedRef: string;
  readonly rootCommit: string;
  readonly rootTree: string;
  readonly policyRevision: string;
  readonly requiredReviewRevision: string;
  readonly requiredJobSetRevision: string;
};

function parseReadinessRequest(value: unknown): ReadinessRequest {
  if (!isRecord(value) || Object.keys(value).length !== 9 || value.schemaVersion !== 1
    || value.repositoryId !== "root") throw new NativeProjectReadinessError();
  const generationId = stringField(value, "generationId");
  const protectedRef = stringField(value, "protectedRef");
  const rootCommit = stringField(value, "rootCommit");
  const rootTree = stringField(value, "rootTree");
  const policyRevision = stringField(value, "policyRevision");
  const requiredReviewRevision = stringField(value, "requiredReviewRevision");
  const requiredJobSetRevision = stringField(value, "requiredJobSetRevision");
  if (!/^[0-9a-f]{64}$/.test(generationId) || !/^refs\/heads\//.test(protectedRef)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(rootCommit)
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(rootTree)) throw new NativeProjectReadinessError();
  return { generationId, repositoryId: "root", protectedRef, rootCommit, rootTree,
    policyRevision, requiredReviewRevision, requiredJobSetRevision };
}

function stringField(value: Readonly<Record<string, unknown>>, field: string): string {
  const selected = value[field];
  if (typeof selected !== "string") throw new NativeProjectReadinessError();
  return selected;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secretEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

class NativeProjectReadinessError extends Error {
  readonly name = "NativeProjectReadinessError";
}
