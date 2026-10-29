import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import type { DiffRequest, DiffService } from "@slop-lab/gs-diff-service";

export const gitDiffServiceKind = "dim.git-diff.service";
export type GitDiffService = {
  gs(): DiffService;
  snapshotInTransaction(request: DiffRequest): ReturnType<DiffService["snapshotInTransaction"]>;
};

export function gitDiffService(extensions: readonly ControlPlaneExtension[]): GitDiffService {
  const entry = extensions.find((extension) => extension.kind === gitDiffServiceKind && extension.name === "default");
  if (entry === undefined || !("gs" in entry.value) || typeof entry.value.gs !== "function"
    || !("snapshotInTransaction" in entry.value) || typeof entry.value.snapshotInTransaction !== "function") throw new Error("Git diff service is unavailable");
  return entry.value as GitDiffService;
}

export { validateDiffAnchor } from "@slop-lab/gs-diff-service";
