import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ControlPlanePlugin } from "@slop-lab/dim-control-plane-core/plugin-api";
import { isNativeGitCandidateRef, repositoryExtension, repositoryAccessProvider, RepositoryAccessError, readNativeProjectRegistrations, readBoundedJson, NativeGitBundleHttpError, sendJson, type RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { codeReviewService, readAuthoritativeNativeReviewRefs } from "@slop-lab/dim-control-plane-plugin-git-review/plugin-api";
import { appendRevision, assertVersion, currentRevision, markMerged, pullRequestSchema, PullRequestConflict, updatePullRequest } from "@slop-lab/git-pull-requests";
import { PullRequestStore } from "./store.js";
import { ownedRevisionRefs, pinRevision, revisionRef } from "./revision-pins.js";
import { pullRequestServiceKind } from "./plugin-api.js";

const version = z.object({ expectedVersion: z.number().int().positive() }).strict();
const create = z.object({ title: z.string().trim().min(1).max(240), body: z.string().max(3000).default(""),
  sourceRef: z.string().max(1024).refine(isNativeGitCandidateRef),
  targetRef: z.string().startsWith("refs/heads/").max(1024).optional() }).strict();
const edit = version.extend({ title: z.string().trim().min(1).max(240).optional(), body: z.string().max(3000).optional(), state: z.enum(["open", "closed"]).optional() }).strict();
const selector = "([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)";
const route = new RegExp(`^/v1/projects/${selector}/repositories/${selector}/pull-requests(?:/([0-9a-f-]{36})(?:/(refresh|review))?)?$`);

export const controlPlanePlugin: ControlPlanePlugin = {
  apiVersion: 1, name: "git-pull-requests",
  configure(raw) {
    z.object({}).strict().parse(raw);
    let store: PullRequestStore | undefined;
    return {
      requiresExtensions: [{ kind: "dim.git-repositories.service", name: "default" }, { kind: "dim.git-repositories.access", name: "default" }, { kind: "dim.code-review.service", name: "default" }],
      extensions: [{ kind: "dim.git-repositories.read-history", name: "git-pull-requests", value: {
        async refs(context: RepositoryExtensionContext, scope: { projectId: string; repositoryId: string }) {
          if (store === undefined || !context.available()) return [];
          const records = await store.list(scope.projectId, scope.repositoryId);
          return records.flatMap((record) => record.revisions.flatMap((revision) => [revisionRef(record.id, revision.id, "base"), revisionRef(record.id, revision.id, "head")]));
        }
      } }, { kind: "dim.git-repositories.feature", name: "git-pull-requests", value: { version: 1 } }, { kind: pullRequestServiceKind, name: "default", value: {
        async read(context: RepositoryExtensionContext, scope: { projectId: string; repositoryId: string }, id: string) {
          if (store === undefined || !context.available()) throw new Error("Pull request service unavailable");
          return store.read(scope.projectId, scope.repositoryId, id);
        },
        async appendComment(context: RepositoryExtensionContext, scope: { projectId: string; repositoryId: string }, id: string, expectedVersion: number, comment: import("@slop-lab/git-discussions").DiscussionComment) {
          if (store === undefined || !context.available()) throw new Error("Pull request service unavailable");
          const record = await store.read(scope.projectId, scope.repositoryId, id);
          if (record === undefined) throw new PullRequestConflict("Pull request not found");
          const { appendComment } = await import("@slop-lab/git-pull-requests");
          const changed = appendComment(record, expectedVersion, comment);
          await store.save(scope.projectId, scope.repositoryId, changed);
          return changed;
        }
      } }, repositoryExtension({ name: "git-pull-requests", ownedRefs: ownedRevisionRefs, async attach(context) {
        const ownedStore = new PullRequestStore(context.extensionStateDirectory);
        store = ownedStore;
        // The durable record precedes each pin. Startup proofs accept missing
        // declared pins, then the trusted owner repairs an interrupted write.
        for (const registration of readNativeProjectRegistrations(context.runtime.state)) {
          const records = await ownedStore.list(registration.projectId, registration.repositoryId);
          const repository = join(context.stateDirectory, registration.projectId, `${registration.repositoryId}.git`);
          for (const record of records) for (const revision of record.revisions) await pinRevision(context, repository, record, revision);
        }
        return { async close() { if (store === ownedStore) store = undefined; }, async handle(request, response, url) {
          const match = url.search === "" ? route.exec(url.pathname) : null;
          if (match === null) return false;
          const projectId = match[1]!, repositoryId = match[2]!, requestId = match[3], operation = match[4];
          if (!((request.method === "GET" && operation === undefined) || (request.method === "POST" && (requestId === undefined || operation !== undefined)) || (request.method === "PATCH" && requestId !== undefined && operation === undefined))) { sendJson(response, 405, { error: "Method not allowed" }); return true; }
          try {
            const body = request.method === "GET" ? undefined : await readBoundedJson(request);
            await context.serialize(async () => {
              const access = await repositoryAccessProvider(context.extensions).authorize(context, request, { projectId, repositoryId });
              if (requestId === undefined) {
                if (request.method === "GET") {
                  const records = await ownedStore.list(projectId, repositoryId);
                  sendJson(response, 200, records.slice(0, 100)); return;
                }
                const input = create.parse(body);
                 const scoped = await repositoryAccessProvider(context.extensions).authorize(context, request, { projectId, repositoryId, ...(input.targetRef === undefined ? {} : { protectedRef: input.targetRef }) });
                 if (input.sourceRef === scoped.target.currentHead.protectedRef) throw new PullRequestConflict("Source and target refs must differ");
                const existing = (await ownedStore.list(projectId, repositoryId)).find((entry) => entry.state === "open" && entry.sourceRef === input.sourceRef && entry.targetRef === scoped.target.currentHead.protectedRef);
                if (existing !== undefined) {
                  if (existing.title !== input.title || existing.body !== input.body) throw new PullRequestConflict(`An open pull request already exists: ${existing.id}`);
                  await pinRevision(context, scoped.target.repository, existing);
                  sendJson(response, 200, existing); return;
                }
                const refs = await snapshot(context, scoped.target, input.sourceRef);
                const now = new Date().toISOString();
                const record = pullRequestSchema.parse({ schemaVersion: 1, id: randomUUID(), version: 1, title: input.title, body: input.body, sourceRef: input.sourceRef, targetRef: scoped.target.currentHead.protectedRef, state: "open", actorId: access.actorId, createdAt: now, updatedAt: now, revisions: [{ id: randomUUID(), sourceCommit: refs.candidateCommit, targetCommit: refs.protectedHead, createdAt: now }], comments: [] });
                await ownedStore.save(projectId, repositoryId, record);
                await pinRevision(context, scoped.target.repository, record); sendJson(response, 201, record); return;
              }
              let record = await ownedStore.read(projectId, repositoryId, requestId);
              if (record === undefined) { sendJson(response, 404, { error: "Pull request not found" }); return; }
              const scoped = await repositoryAccessProvider(context.extensions).authorize(context, request, { projectId, repositoryId, protectedRef: record.targetRef });
              if (request.method === "GET") { sendJson(response, 200, record); return; }
              const now = new Date().toISOString();
              if (operation === "refresh") {
                const input = version.parse(body); assertVersion(record, input.expectedVersion);
                if (record.state !== "open") { sendJson(response, 200, record); return; }
                if (scoped.target.currentHead.commit === currentRevision(record).sourceCommit) record = markMerged(record, input.expectedVersion, now);
                else {
                  const refs = await snapshot(context, scoped.target, record.sourceRef);
                  record = appendRevision(record, input.expectedVersion, { id: randomUUID(), sourceCommit: refs.candidateCommit, targetCommit: refs.protectedHead, createdAt: now });
                }
              } else if (operation === "review") {
                const input = version.parse(body); assertVersion(record, input.expectedVersion);
                if (record.state !== "open") throw new PullRequestConflict("Pull request is not open");
                const refs = await snapshot(context, scoped.target, record.sourceRef);
                const pinned = currentRevision(record);
                if (refs.candidateCommit !== pinned.sourceCommit || refs.protectedHead !== pinned.targetCommit) throw new PullRequestConflict("Pull request revision is stale; refresh before reviewing");
                // Reuse review authority while retaining the already held mutation queue.
                const review = await codeReviewService(context.extensions).createInTransaction(context, { projectId, repositoryId, proposalRef: record.sourceRef, protectedRef: record.targetRef });
                if (review.review.candidateCommit !== pinned.sourceCommit || review.review.expectedProtectedHead !== pinned.targetCommit) throw new PullRequestConflict("Review does not match pull request revision");
                sendJson(response, 200, { pullRequestId: record.id, revisionId: pinned.id, review }); return;
              } else {
                const input = edit.parse(body);
                record = updatePullRequest(record, input.expectedVersion, { ...(input.title === undefined ? {} : { title: input.title }), ...(input.body === undefined ? {} : { body: input.body }), ...(input.state === undefined ? {} : { state: input.state }) }, now);
              }
              await ownedStore.save(projectId, repositoryId, record);
              if (operation === "refresh" && record.state === "open") await pinRevision(context, scoped.target.repository, record);
              sendJson(response, 200, record);
            });
          } catch (error) {
            if (error instanceof RepositoryAccessError) sendJson(response, error.status, { error: error.message });
            else if (error instanceof PullRequestConflict) sendJson(response, 409, { error: error.message });
            else if (error instanceof z.ZodError || error instanceof NativeGitBundleHttpError) sendJson(response, 400, { error: "Invalid pull request input" });
            else throw error;
          }
          return true;
        } };
      } })],
      async start() { return { async close() {} }; }
    };
  }
};
async function snapshot(context: RepositoryExtensionContext, target: Awaited<ReturnType<ReturnType<typeof repositoryAccessProvider>["authorize"]>>["target"], sourceRef: string) {
  if (!isNativeGitCandidateRef(sourceRef)) throw new PullRequestConflict("Invalid candidate ref");
  let refs;
  try { refs = await readAuthoritativeNativeReviewRefs({ gitExecutable: context.runtime.gitExecutable, gitIdentity: context.runtime.gitIdentity, repository: target.repository, protectedRef: target.currentHead.protectedRef, proposalRef: sourceRef, signal: context.signal }); }
  catch { throw new PullRequestConflict("Candidate snapshot is unavailable"); }
  if (refs.protectedHead !== target.currentHead.commit) throw new PullRequestConflict("Target changed while resolving pull request");
  return refs;
}
export { PullRequestStore } from "./store.js";
