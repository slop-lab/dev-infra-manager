import { parseGitDiff, type DiffLineAnchor, type DiffSnapshot } from "@slop-lab/gs-diff";
import type { RepositorySelector } from "@slop-lab/gs-repository-contracts";
import type {
  BorrowedRepositoryReadAccess,
  RepositoryReadGate,
  RepositoryReadService,
  RepositoryTarget,
} from "@slop-lab/gs-repository-service";

export interface RepositoryPrincipalScope {
  readonly principalId: string;
  authorize(target: RepositoryTarget): Promise<void>;
}

export type DiffServiceOptions = {
  readonly readGate: RepositoryReadGate;
  readonly reader: RepositoryReadService;
  readonly historyRefs?: (selector: RepositorySelector) => Promise<readonly string[]>;
};

export type DiffRequest = RepositorySelector & {
  readonly principal: RepositoryPrincipalScope;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly signal?: AbortSignal;
};

export interface DiffService {
  snapshot(request: DiffRequest): Promise<DiffSnapshot>;
  snapshotInTransaction(access: BorrowedRepositoryReadAccess, request: DiffRequest): Promise<DiffSnapshot>;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export function createDiffService(options: DiffServiceOptions): DiffService {
  const snapshotInTransaction = async ({ authority, target }: BorrowedRepositoryReadAccess, request: DiffRequest): Promise<DiffSnapshot> => {
        await request.principal.authorize(target);
        const repositoryAccess = { principalId: request.principal.principalId, target };
        const signal = request.signal ?? AbortSignal.timeout(30_000);
        await options.reader.assertAdvertisedCommits({
          access: repositoryAccess,
          commits: [request.baseCommit, request.headCommit],
          ...(options.historyRefs === undefined ? {} : { advertisedRefs: await options.historyRefs(request) }),
          signal,
        });
        const patch = utf8(await options.reader.readBytes({
          access: repositoryAccess,
          args: ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "-l100", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", request.baseCommit, request.headCommit, "--"],
          signal,
          maximumBytes: 4 * 1024 * 1024,
        }));
        const parsed = parseGitDiff(patch, {
          baseCommit: request.baseCommit,
          headCommit: request.headCommit,
          maxBytes: 4 * 1024 * 1024,
          maxFiles: 500,
          maxLines: 50_000,
        });
        const files = [];
        for (const file of parsed.files) {
          const oldBlob = file.oldPath === null ? null : await options.reader.readTreeFile({ access: repositoryAccess, commit: request.baseCommit, path: file.oldPath, signal });
          const newBlob = file.newPath === null ? null : await options.reader.readTreeFile({ access: repositoryAccess, commit: request.headCommit, path: file.newPath, signal });
          files.push({ ...file, ...(oldBlob === null ? {} : { oldBlob }), ...(newBlob === null ? {} : { newBlob }) });
        }
        const result = { ...parsed, files };
        if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) {
          throw new DiffServiceError("structured diff exceeds the response limit");
        }
        await request.principal.authorize(target);
        await authority.assertCurrent(target);
        return result;
  };
  return {
    snapshot(request) {
      return options.readGate.read(request, (access) => snapshotInTransaction(access, request));
    },
    snapshotInTransaction,
  };
}

export function validateDiffAnchor(snapshot: DiffSnapshot, anchor: DiffLineAnchor): boolean {
  if (snapshot.baseCommit !== anchor.baseCommit || snapshot.headCommit !== anchor.headCommit
    || !Number.isSafeInteger(anchor.line) || anchor.line < 1) return false;
  return snapshot.files.some((file) => {
    const blob = anchor.side === "base" ? file.oldBlob : file.newBlob;
    return !file.binary && blob?.lineCount !== null && (blob?.lineCount === undefined || anchor.line <= blob.lineCount)
      && (anchor.side === "base" ? file.oldPath : file.newPath) === anchor.path
      && file.hunks.some((hunk) => hunk.lines.some((line) => (anchor.side === "base" ? line.oldLine : line.newLine) === anchor.line));
  });
}

function utf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new DiffServiceError("repository diff contains non-UTF-8 text");
    throw error;
  }
}

export class DiffServiceError extends Error {
  readonly name = "DiffServiceError";
}
