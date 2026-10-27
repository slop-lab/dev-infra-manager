import { parseGitDiff, type DiffSnapshot } from "@slop-lab/gs-diff";
import { nativeRepositoryBranches } from "@slop-lab/dim-contracts-git";
import { repositoryReadHistoryRefs, exactActivationIsBound, resolveAuthoritativeNativeRepositoryTarget, type RepositoryExtensionContext } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { assertAdvertisedCommits, gitBytes, readTreeFile, utf8, RepositoryReadError } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import type { DiffSelector } from "./plugin-api.js";
export function assertReadActive(context: RepositoryExtensionContext): void {
  if (!context.available() || !context.runtime.activated() || !exactActivationIsBound(context.runtime.state, context.runtime.expectedGenerationId, context.runtime.activationTokenDigest)) throw new RepositoryReadError("repository read service is unavailable");
}
export async function snapshot(context: RepositoryExtensionContext, selector: DiffSelector): Promise<DiffSnapshot> {
  assertReadActive(context);
  const target = await resolveAuthoritativeNativeRepositoryTarget(context.runtime, { projectId: selector.projectId, repositoryId: selector.repositoryId });
  const git = { ...context.runtime, repository: target.repository, signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) };
  await assertAdvertisedCommits(git, [selector.baseCommit, selector.headCommit], Object.keys(nativeRepositoryBranches(target.imported.policy)), await repositoryReadHistoryRefs(context, selector));
  const patch = utf8(await gitBytes(git, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "-l100", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", selector.baseCommit, selector.headCommit, "--"]));
  const parsed = parseGitDiff(patch, { baseCommit: selector.baseCommit, headCommit: selector.headCommit, maxBytes: 4 * 1024 * 1024, maxFiles: 500, maxLines: 50_000 });
  const files = [];
  for (const file of parsed.files) {
    const oldBlob = file.oldPath === null ? null : await readTreeFile(git, selector.baseCommit, file.oldPath);
    const newBlob = file.newPath === null ? null : await readTreeFile(git, selector.headCommit, file.newPath);
    files.push({ ...file, ...(oldBlob === null ? {} : { oldBlob }), ...(newBlob === null ? {} : { newBlob }) });
  }
  const result = { ...parsed, files };
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new RepositoryReadError("structured diff exceeds the response limit");
  assertReadActive(context);
  return result;
}
