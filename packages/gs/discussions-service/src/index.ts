import { randomUUID } from "node:crypto";
import type { DiffLineAnchor } from "@slop-lab/gs-diff";
import { validateDiffAnchor, type DiffService } from "@slop-lab/gs-diff-service";
import type { DiscussionAnchor } from "@slop-lab/gs-discussions";
import type { PullRequestService, RepositoryPrincipalScope } from "@slop-lab/gs-pull-request-service";
import { assertVersion, PullRequestConflict, type PullRequest } from "@slop-lab/gs-pull-requests";
import type { RepositorySelector } from "@slop-lab/gs-repository-contracts";
import type { RepositoryMutationGate } from "@slop-lab/gs-repository-service";

export type DiscussionsServiceOptions = {
  readonly mutationGate: RepositoryMutationGate;
  readonly pullRequests: PullRequestService;
  readonly diff: DiffService;
  readonly now?: () => string;
  readonly newId?: () => string;
};

export type AddCommentRequest = RepositorySelector & {
  readonly principal: RepositoryPrincipalScope;
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly revisionId: string;
  readonly body: string;
  readonly anchor?: DiscussionAnchor;
  readonly signal?: AbortSignal;
};

export interface DiscussionsService {
  addComment(request: AddCommentRequest): Promise<PullRequest>;
}

export function createDiscussionsService(options: DiscussionsServiceOptions): DiscussionsService {
  return {
    addComment(request) {
      return options.mutationGate.mutate(request, async (access) => {
        await request.principal.authorize(access.target);
        const record = await options.pullRequests.readInTransaction(request);
        if (record === undefined) throw new DiscussionsNotFoundError(request.requestId);
        assertVersion(record, request.expectedVersion);
        const revision = record.revisions.find((entry) => entry.id === request.revisionId);
        if (revision === undefined) throw new PullRequestConflict("Comment revision does not belong to this pull request");
        if (request.anchor !== undefined) {
          const snapshot = await options.diff.snapshotInTransaction(access, {
            namespaceId: request.namespaceId,
            repositoryId: request.repositoryId,
            principal: request.principal,
            baseCommit: revision.targetCommit,
            headCommit: revision.sourceCommit,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
          const anchor: DiffLineAnchor = {
            ...request.anchor,
            baseCommit: revision.targetCommit,
            headCommit: revision.sourceCommit,
          };
          if (!validateDiffAnchor(snapshot, anchor)) throw new PullRequestConflict("Comment anchor is not a visible line in this revision");
        }
        const now = options.now?.() ?? new Date().toISOString();
        return options.pullRequests.appendCommentInTransaction(access, {
          namespaceId: request.namespaceId,
          repositoryId: request.repositoryId,
          principal: request.principal,
          requestId: request.requestId,
          expectedVersion: request.expectedVersion,
          comment: {
            id: options.newId?.() ?? randomUUID(),
            actorId: request.principal.principalId,
            body: request.body,
            revisionId: revision.id,
            createdAt: now,
            ...(request.anchor === undefined ? {} : { anchor: request.anchor }),
          },
        });
      });
    },
  };
}

export class DiscussionsNotFoundError extends Error {
  readonly name = "DiscussionsNotFoundError";
  constructor(readonly requestId: string) {
    super("Pull request not found");
  }
}
