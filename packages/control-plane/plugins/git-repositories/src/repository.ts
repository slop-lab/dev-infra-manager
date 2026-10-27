import { initializeRepository, assertRegisteredRepository as assertRepository,
  type GitRepositoryRuntime } from "@slop-lab/gs-repository";

export { assertGitVersion, assertGitExecutableIdentity, GitRepositoryError } from "@slop-lab/gs-repository";
export type { GitRepositoryRuntime, GitExecutableIdentity } from "@slop-lab/gs-repository";
export interface GitRepositoryTarget { readonly projectId: string; readonly repositoryId: string }

export function initializeNativeRepository(config: GitRepositoryRuntime, target: GitRepositoryTarget): Promise<string> {
  return initializeRepository(config, { namespaceId: target.projectId, repositoryId: target.repositoryId });
}

export function assertRegisteredRepository(config: Pick<GitRepositoryRuntime, "storageRoot" | "gitExecutable">,
  target: GitRepositoryTarget): Promise<void> {
  return assertRepository(config, { namespaceId: target.projectId, repositoryId: target.repositoryId });
}
