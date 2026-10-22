import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import type { NativeProjectRecord } from "./nativeProjectPendingCodec.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";
import { nativeRepositoryBranches, nativeRepositoryDefaultRef } from "@slop-lab/dim-contracts-git";

/** Admission receipts remain immutable; current serving authority proves catalog availability. */
export async function nativeProjectCatalogEntry(project: NativeProjectRecord, selected: NativeControlPlaneConnection) {
  const available = await Promise.all(Object.values(project.repositories).filter(({ phase }) => phase === "ready").map(async (repository) => {
    try {
      await proveNativeProjectReadiness(selected, project, repository.repositoryId, AbortSignal.timeout(5000), {
        commit: repository.commit, tree: repository.tree, allowFastForward: true
      });
      return repository.repositoryId;
    } catch { return undefined; }
  }));
  const repositoryIds = available.filter((id): id is string => id !== undefined).sort();
  return { projectId: project.projectId, name: project.name, repositoryIds,
    repositories: repositoryIds.map((repositoryId) => {
      const policy = project.repositories[repositoryId]!.repositoryPolicy;
      return { repositoryId, defaultRef: nativeRepositoryDefaultRef(policy), branches: Object.keys(nativeRepositoryBranches(policy)).sort() };
    }) };
}
