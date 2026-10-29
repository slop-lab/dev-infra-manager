import { currentRevision, type PullRequest, type PullRequestRevision } from "@slop-lab/gs-pull-requests";
import type { RepositoryAccess } from "@slop-lab/gs-repository-service";

export type OwnedPullRequestRef = { readonly ref: string; readonly commit: string };

export interface PullRequestRefWriter {
  ensure(input: {
    readonly access: RepositoryAccess;
    readonly ref: string;
    readonly commit: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

export function revisionRef(requestId: string, revisionId: string, side: "base" | "head"): string {
  return `refs/dim/extensions/git-pull-requests/${requestId}/revisions/${revisionId}/${side}`;
}

export function recordRefs(record: PullRequest): readonly OwnedPullRequestRef[] {
  return record.revisions.flatMap((revision) => [
    { ref: revisionRef(record.id, revision.id, "base"), commit: revision.targetCommit },
    { ref: revisionRef(record.id, revision.id, "head"), commit: revision.sourceCommit },
  ]);
}

export async function pinRevision(
  writer: PullRequestRefWriter,
  access: RepositoryAccess,
  record: PullRequest,
  signal: AbortSignal,
  revision: PullRequestRevision = currentRevision(record),
): Promise<void> {
  await writer.ensure({ access, ref: revisionRef(record.id, revision.id, "base"), commit: revision.targetCommit, signal });
  await writer.ensure({ access, ref: revisionRef(record.id, revision.id, "head"), commit: revision.sourceCommit, signal });
}
