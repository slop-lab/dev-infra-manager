import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { isOrdinaryCandidateRef as isNativeGitOrdinaryCandidateRef } from "@slop-lab/gs-repository-contracts";
import {
  assertAuthoritativeNativeRepositoryTargetCurrent,
  readBoundedJson,
  resolveAuthoritativeNativeRepositoryTarget,
  sendJson,
  sendNotFound,
  WorkspaceWriteAuthorizationError,
  workspaceProtectedRefs,
  type RepositoryExtensionContext,
} from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import {
  assertAuthoritativeNativeReviewRefs,
  codeReviewService,
  ownedReviewDirectory,
  readReviewJson,
  writeImmutableReviewRecord,
} from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import type { GitCiRuntime } from "./runtime.js";
import { readWorkspaceCiStatus } from "./workspace-status.js";
import { workspaceCiEvidence, type WorkspaceCiEvidenceClient } from "./workspace-evidence.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const requestObjectSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().uuid().toLowerCase(),
  candidateRef: z.string().refine(isNativeGitOrdinaryCandidateRef),
  candidateCommit: objectId,
  candidateTree: objectId,
  protectedRef: z.string().startsWith("refs/heads/").optional(),
}).strict();
const requestSchema = requestObjectSchema.readonly();
type CandidateRequest = z.infer<typeof requestSchema>;
const storedRequestSchema = requestObjectSchema.extend({
  projectId: identifier,
  repositoryId: identifier,
  workspaceId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  generationId: z.string().regex(/^[a-f0-9]{64}$/),
  expectedProtectedHead: objectId,
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().readonly();
type StoredRequest = z.infer<typeof storedRequestSchema>;
export type StoredWorkspaceCiRequest = StoredRequest;
const resultSchema = z.object({ schemaVersion: z.literal(1), requestId: z.string().uuid(), reviewId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();

export async function handleWorkspaceCandidateCi(context: RepositoryExtensionContext, runtime: GitCiRuntime,
  http: { readonly request: IncomingMessage; readonly response: ServerResponse; readonly url: URL; readonly accepted: () => void },
  evidenceClient?: WorkspaceCiEvidenceClient): Promise<boolean> {
  const { request, response, url } = http;
  const match = /^\/v1\/projects\/([a-z0-9][a-z0-9-]{0,63})\/repositories\/([a-z0-9][a-z0-9-]{0,63})\/workspace-ci\/requests(?:\/([0-9a-f-]{36})(\/jobs(?:\/[0-9a-f-]{36}\/(?:logs|artifacts)(?:\/[0-9a-f]{64})?)?)?)?$/.exec(url.pathname);
  if (!match || url.search !== "" || !["GET", "POST"].includes(request.method ?? "")) return false;
  const projectId = match[1], repositoryId = match[2], routeRequestId = match[3], evidenceSuffix = match[4];
  if (!projectId || !repositoryId || request.method === "GET" && !routeRequestId || request.method === "POST" && routeRequestId) {
    sendNotFound(response); return true;
  }
  try {
    if (request.method === "GET") {
      const lease = await context.authorizeWorkspaceLease(request, { projectId, repositoryId });
      const result = await context.read(async () => {
        const root = join(context.extensionStateDirectory, "workspace-requests");
        const stored = await optionalRequest(join(root, `${routeRequestId}.request.json`));
        const completed = await optionalResult(join(root, `${routeRequestId}.result.json`));
        if (!stored || !completed || stored.projectId !== projectId || stored.repositoryId !== repositoryId || stored.workspaceId !== lease.workspaceId) return;
        const currentRuntime = { ...runtime, authoritativeTargetProofs: new Map() };
        const status = await publishedStatus({ runtime: currentRuntime, request: stored, reviewId: completed.reviewId });
        if (evidenceSuffix === undefined) return { status };
        if (!evidenceClient || stored.generationId !== runtime.expectedGenerationId || status.status.state === "stale") return;
        const target = await currentEvidenceTarget(currentRuntime, stored);
        if (target === undefined) return;
        const evidence = await workspaceCiEvidence({ client: evidenceClient, target, request: stored, reviewId: completed.reviewId, suffix: evidenceSuffix });
        // Network reads do not extend authority: revalidate the reviewed candidate and policy afterward.
        const final = await currentEvidenceTarget({ ...runtime, authoritativeTargetProofs: new Map() }, stored);
        return final === undefined || evidence === undefined ? undefined : { evidence };
      });
      await context.authorizeWorkspaceLease(request, { projectId, repositoryId });
      if (result === undefined) sendNotFound(response);
      else if ("status" in result) sendJson(response, 200, result.status);
      else response.writeHead(200, { "content-type": result.evidence.contentType, "cache-control": "no-store" }).end(result.evidence.body);
      return true;
    }
    await context.mutate({ projectId, repositoryId }, async () => {
      const lease = await context.authorizeWorkspaceLease(request, { projectId, repositoryId });
      const runtimeWithProofs = { ...runtime, authoritativeTargetProofs: new Map() };
      const root = join(context.extensionStateDirectory, "workspace-requests");
      await ownedReviewDirectory(root);
      if (request.method === "POST") {
        const input = requestSchema.parse(await readBoundedJson(request));
        const requestFile = join(root, `${input.requestId}.request.json`);
        const resultFile = join(root, `${input.requestId}.result.json`);
        const existing = await optionalRequest(requestFile);
        if (existing !== undefined) {
          if (existing.projectId !== projectId || existing.repositoryId !== repositoryId || existing.workspaceId !== lease.workspaceId) return sendJson(response, 409, { error: "workspace CI request identity conflicts" });
          if (existing.generationId !== runtime.expectedGenerationId) return sendJson(response, 409, { error: "workspace CI request belongs to an older service generation; use a new request ID" });
          const expected = { ...input, projectId, repositoryId, workspaceId: lease.workspaceId,
            generationId: runtime.expectedGenerationId,
            expectedProtectedHead: existing.expectedProtectedHead, policyDigest: existing.policyDigest };
          if (!isDeepStrictEqual(existing, expected)) return sendJson(response, 409, { error: "workspace CI request identity conflicts" });
          const completed = await optionalResult(resultFile);
           if (completed !== undefined) { sendJson(response, 200, await publishedStatus({ runtime: runtimeWithProofs, request: existing, reviewId: completed.reviewId })); http.accepted(); return; }
        }
        const target = await resolveAuthoritativeNativeRepositoryTarget(runtimeWithProofs, {
          projectId, repositoryId, ...(input.protectedRef === undefined ? {} : { protectedRef: input.protectedRef }),
        });
        if (!Object.hasOwn(target.imported.policy.extensions, "git-ci")) return sendJson(response, 409, { error: "repository has no configured Git CI policy; no candidate CI was requested" });
        if (workspaceProtectedRefs(target.imported.policy).includes(input.candidateRef)) return sendJson(response, 403, { error: "protected refs cannot be workspace CI candidates" });
        const stored = storedRequestSchema.parse({ ...input, projectId, repositoryId, workspaceId: lease.workspaceId,
          generationId: runtime.expectedGenerationId,
          expectedProtectedHead: target.currentHead.commit, policyDigest: target.imported.policyDigest });
        if (existing !== undefined && (existing.expectedProtectedHead !== stored.expectedProtectedHead || existing.policyDigest !== stored.policyDigest)) {
          return sendJson(response, 409, { error: "workspace CI request is stale; use a new request ID" });
        }
        await assertAuthoritativeNativeReviewRefs({ gitExecutable: runtime.gitExecutable, gitIdentity: runtime.gitIdentity,
          repository: target.repository, signal: AbortSignal.timeout(30_000), protectedRef: target.currentHead.protectedRef,
          proposalRef: input.candidateRef, expectedProtectedHead: target.currentHead.commit,
          candidateCommit: input.candidateCommit, candidateTree: input.candidateTree });
        await assertAuthoritativeNativeRepositoryTargetCurrent({ runtime: runtimeWithProofs,
          selector: { projectId, repositoryId, ...(input.protectedRef === undefined ? {} : { protectedRef: input.protectedRef }) }, target });
        if (existing === undefined) await writeImmutableReviewRecord(requestFile, stored);
        const envelope = await codeReviewService(context.extensions).createInTransaction(context, {
          projectId, repositoryId, proposalRef: input.candidateRef,
          ownerRequestId: `workspace:${input.requestId}`,
          ...(input.protectedRef === undefined ? {} : { protectedRef: input.protectedRef }),
        });
        if (envelope.review.candidateCommit !== input.candidateCommit || envelope.review.candidateTree !== input.candidateTree
          || envelope.review.proposalRef !== input.candidateRef || envelope.review.expectedProtectedHead !== stored.expectedProtectedHead) {
          throw new WorkspaceCandidateCiError(409, "workspace CI candidate changed during review creation");
        }
        const completed = resultSchema.parse({ schemaVersion: 1, requestId: input.requestId, reviewId: envelope.review.reviewId });
        await writeImmutableReviewRecord(resultFile, completed);
        http.accepted();
        sendJson(response, 200, await publishedStatus({ runtime: runtimeWithProofs, request: stored, reviewId: completed.reviewId }));
        return;
      }
    });
  } catch (error) {
    if (error instanceof WorkspaceWriteAuthorizationError || error instanceof WorkspaceCandidateCiError) sendJson(response, error.status, { error: error.message });
    else if (error instanceof z.ZodError) sendJson(response, 400, { error: "invalid workspace CI request" });
    else if (error instanceof Error) sendJson(response, 409, { error: "workspace CI candidate is unavailable or stale" });
    else throw error;
  }
  return true;
}

async function publishedStatus(input: { readonly runtime: GitCiRuntime; readonly request: StoredRequest; readonly reviewId: string }) {
  const { runtime, request, reviewId } = input;
  const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: request.projectId, repositoryId: request.repositoryId,
    ...(request.protectedRef === undefined ? {} : { protectedRef: request.protectedRef }) });
  const status = await readWorkspaceCiStatus(runtime, target, reviewId);
  if (status === undefined) throw new WorkspaceCandidateCiError(409, "workspace CI review is unavailable");
  await assertAuthoritativeNativeRepositoryTargetCurrent({ runtime: { ...runtime, authoritativeTargetProofs: new Map() },
    selector: { projectId: request.projectId, repositoryId: request.repositoryId, ...(request.protectedRef === undefined ? {} : { protectedRef: request.protectedRef }) }, target });
  const scopedStatus = request.generationId === runtime.expectedGenerationId ? status : { ...status, state: "stale" as const, reason: "request-generation-stale" };
  return { schemaVersion: 1, requestId: request.requestId, candidateRef: request.candidateRef, generationId: request.generationId, currentGenerationId: runtime.expectedGenerationId,
    candidateCommit: request.candidateCommit, candidateTree: request.candidateTree, protectedRef: target.currentHead.protectedRef, reviewId, status: scopedStatus };
}

/** Status is diagnostic; removed CI or changed policy must independently revoke evidence reads. */
async function currentEvidenceTarget(runtime: GitCiRuntime, request: StoredRequest) {
  if (request.generationId !== runtime.expectedGenerationId) return;
  const selector = { projectId: request.projectId, repositoryId: request.repositoryId,
    ...(request.protectedRef === undefined ? {} : { protectedRef: request.protectedRef }) };
  const target = await resolveAuthoritativeNativeRepositoryTarget(runtime, selector);
  if (!Object.hasOwn(target.imported.policy.extensions, "git-ci") || target.imported.policyDigest !== request.policyDigest
    || target.currentHead.commit !== request.expectedProtectedHead) return;
  await assertAuthoritativeNativeReviewRefs({ gitExecutable: runtime.gitExecutable, gitIdentity: runtime.gitIdentity,
    repository: target.repository, signal: AbortSignal.timeout(30_000), protectedRef: target.currentHead.protectedRef,
    proposalRef: request.candidateRef, expectedProtectedHead: request.expectedProtectedHead,
    candidateCommit: request.candidateCommit, candidateTree: request.candidateTree });
  await assertAuthoritativeNativeRepositoryTargetCurrent({ runtime: { ...runtime, authoritativeTargetProofs: new Map() }, selector, target });
  return target;
}

async function optionalRequest(file: string): Promise<StoredRequest | undefined> {
  try { return storedRequestSchema.parse(await readReviewJson(file, 64 * 1024)); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
}
async function optionalResult(file: string): Promise<z.infer<typeof resultSchema> | undefined> {
  try { return resultSchema.parse(await readReviewJson(file, 64 * 1024)); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
}
class WorkspaceCandidateCiError extends Error {
  constructor(readonly status: 409, message: string) { super(message); }
}
