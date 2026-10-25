import type { NativeControlPlaneConnection } from "./nativeControlPlaneConnection.js";
import type { NativeProjectRecord } from "./nativeProjectPendingCodec.js";
import { proveNativeProjectReadiness } from "./nativeProjectReadinessClient.js";
import { nativeRepositoryBranches, nativeRepositoryDefaultRef } from "@slop-lab/dim-contracts-git";

export function nativeProjectSelectionEntry(project: NativeProjectRecord) {
  const repositories = Object.values(project.repositories).sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))
    .map(({ repositoryId, repositoryPolicy }) => ({ repositoryId, defaultRef: nativeRepositoryDefaultRef(repositoryPolicy),
      branches: Object.keys(nativeRepositoryBranches(repositoryPolicy)).sort() }));
  return { projectId: project.projectId, name: project.name, repositoryIds: repositories.map(({ repositoryId }) => repositoryId), repositories };
}

/** Admission receipts remain immutable; current serving authority proves catalog availability. */
export async function nativeProjectCatalogEntry(project: NativeProjectRecord, selected: NativeControlPlaneConnection) {
  const available = await Promise.all(Object.values(project.repositories).filter(({ phase }) => phase === "ready").map(async (repository) => {
    try {
      await proveNativeProjectReadiness(selected, project, repository.repositoryId, AbortSignal.timeout(35_000), {
        commit: repository.commit, tree: repository.tree, allowFastForward: true
      });
      return repository.repositoryId;
    } catch { return undefined; }
  }));
  const repositoryIds = available.filter((id): id is string => id !== undefined).sort();
  const entry = nativeProjectSelectionEntry(project);
  return { ...entry, repositoryIds,
    repositories: entry.repositories.filter(({ repositoryId }) => repositoryIds.includes(repositoryId)) };
}
