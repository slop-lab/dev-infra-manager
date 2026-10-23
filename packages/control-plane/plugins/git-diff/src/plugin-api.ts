import type { ControlPlaneExtension } from "@slop-lab/dim-control-plane-core/plugin-api";
import type { RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type { DiffLineAnchor, DiffSnapshot } from "@slop-lab/git-diff";

export type DiffSelector = {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly baseCommit: string;
  readonly headCommit: string;
};
/** Trusted callers authorize the actor and hold the repository mutation queue. */
export interface GitDiffService {
  snapshot(context: RepositoryExtensionContext, selector: DiffSelector): Promise<DiffSnapshot>;
}
export const gitDiffServiceKind = "dim.git-diff.service";
export function gitDiffService(extensions: readonly ControlPlaneExtension[]): GitDiffService {
  const entry = extensions.find((extension) => extension.kind === gitDiffServiceKind && extension.name === "default");
  if (entry === undefined || !("snapshot" in entry.value) || typeof entry.value.snapshot !== "function") throw new Error("Git diff service is unavailable");
  return entry.value as GitDiffService;
}
/** Comments attach to an exact visible text line, never an approximate renamed path. */
export function validateDiffAnchor(snapshot: DiffSnapshot, anchor: DiffLineAnchor): boolean {
  if (snapshot.baseCommit !== anchor.baseCommit || snapshot.headCommit !== anchor.headCommit || !Number.isSafeInteger(anchor.line) || anchor.line < 1) return false;
  if (anchor.side !== "base" && anchor.side !== "head") return false;
  return snapshot.files.some((file) => {
    const blob = anchor.side === "base" ? file.oldBlob : file.newBlob;
    return !file.binary && blob?.lineCount !== null && (blob?.lineCount === undefined || anchor.line <= blob.lineCount)
      && (anchor.side === "base" ? file.oldPath : file.newPath) === anchor.path
      && file.hunks.some((hunk) => hunk.lines.some((line) => (anchor.side === "base" ? line.oldLine : line.newLine) === anchor.line));
  });
}
