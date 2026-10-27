import { candidateDescendsFrom as descendsFrom, atomicPromote as promote,
  type GitRepositoryRuntime } from "@slop-lab/gs-repository";

type Target = { readonly projectId: string; readonly repositoryId: string; readonly protectedRef: string; readonly proposalRef: string };
type Runtime = Pick<GitRepositoryRuntime, "gitExecutable" | "storageRoot">;

export function candidateDescendsFrom(config: Runtime, target: Pick<Target, "projectId" | "repositoryId">,
  expectedHead: string, candidateCommit: string): Promise<boolean> {
  return descendsFrom(config, { namespaceId: target.projectId, repositoryId: target.repositoryId }, expectedHead, candidateCommit);
}

export function atomicPromote(config: Runtime, target: Target, expectedHead: string, candidateCommit: string): Promise<boolean> {
  return promote(config, { namespaceId: target.projectId, repositoryId: target.repositoryId,
    protectedRef: target.protectedRef, proposalRef: target.proposalRef }, expectedHead, candidateCommit);
}
