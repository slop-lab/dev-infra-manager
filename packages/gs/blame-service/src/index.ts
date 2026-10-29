import {
  GitBlameParseError,
  gitBlameRequestSchema,
  parseLinePorcelain,
  type GitLineAttribution,
} from "@slop-lab/gs-blame";
import type { RepositorySelector } from "@slop-lab/gs-repository-contracts";
import type {
  RepositoryReadGate,
  RepositoryReadService,
  RepositoryTarget,
} from "@slop-lab/gs-repository-service";
import { z } from "zod";

export interface RepositoryPrincipalScope {
  readonly principalId: string;
  authorize(target: RepositoryTarget): Promise<void>;
}

export type BlameServiceOptions = {
  readonly readGate: RepositoryReadGate;
  readonly reader: RepositoryReadService;
  readonly historyRefs?: (selector: RepositorySelector) => Promise<readonly string[]>;
};

export type BlameRequest = RepositorySelector & {
  readonly principal: RepositoryPrincipalScope;
  readonly commit: string;
  readonly path: string;
  readonly line: number;
  readonly signal?: AbortSignal;
};

export interface BlameService {
  line(request: BlameRequest): Promise<GitLineAttribution>;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export function createBlameService(options: BlameServiceOptions): BlameService {
  return {
    line(request) {
      const body = gitBlameRequestSchema.parse({ commit: request.commit, path: request.path, line: request.line });
      return options.readGate.read(request, async ({ authority, target }) => {
        await request.principal.authorize(target);
        const access = { principalId: request.principal.principalId, target };
        const signal = request.signal ?? AbortSignal.timeout(30_000);
        await options.reader.assertAdvertisedCommits({
          access,
          commits: [body.commit],
          ...(options.historyRefs === undefined ? {} : { advertisedRefs: await options.historyRefs(request) }),
          signal,
        });
        const file = await options.reader.readTreeFile({ access, commit: body.commit, path: body.path, signal });
        if (file?.lineCount === null || file === null || body.line > file.lineCount) {
          throw new BlameServiceError("blame requires an existing text line");
        }
        const output = utf8(await options.reader.readBytes({
          access,
          args: ["-c", "mailmap.file=/dev/null", "-c", "mailmap.blob=", "blame", "--no-textconv", "--ignore-revs-file", "", "--line-porcelain", "--encoding=UTF-8", "--no-progress", "-L", `${body.line},${body.line}`, body.commit, "--", body.path],
          signal,
          maximumBytes: 256 * 1024,
        }));
        let result: GitLineAttribution;
        try {
          result = parseLinePorcelain(output, body);
        } catch (error) {
          if (error instanceof GitBlameParseError || error instanceof z.ZodError) {
            throw new BlameServiceError("Git line attribution is invalid");
          }
          throw error;
        }
        await request.principal.authorize(target);
        await authority.assertCurrent(target);
        return result;
      });
    },
  };
}

function utf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new BlameServiceError("Git line attribution is invalid");
    throw error;
  }
}

export class BlameServiceError extends Error {
  readonly name = "BlameServiceError";
}
