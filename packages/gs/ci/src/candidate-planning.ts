import { z } from "zod";
import { CandidateExecutionError, type WorkflowCompiler } from "@slop-lab/gs-ci-contracts";
import type { RepositoryAuthority, RepositoryTarget } from "@slop-lab/gs-repository-service";
import {
  readNativeCandidateJobInputsFromGit,
  type NativeCandidateJobInputs,
} from "./candidate-job-inputs.js";
import type { CandidateGitReader } from "./candidate-execution-git.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const selectorSchema = z.object({
  namespaceId: identifier,
  repositoryId: identifier,
  protectedRef: z.string().startsWith("refs/heads/").optional(),
  candidateCommit: objectId,
  candidateTree: objectId,
}).strict().readonly();

export type CandidateJobSelector = z.infer<typeof selectorSchema>;

export interface CandidateReaderProvider {
  open(target: RepositoryTarget): CandidateGitReader;
}

export async function loadCandidateJobInputs(input: {
  readonly authority: RepositoryAuthority;
  readonly readers: CandidateReaderProvider;
  readonly compiler: WorkflowCompiler;
  readonly selector: CandidateJobSelector;
}): Promise<NativeCandidateJobInputs> {
  try {
    const selected = selectorSchema.parse(input.selector);
    const target = await input.authority.resolve({
      namespaceId: selected.namespaceId,
      repositoryId: selected.repositoryId,
      ...(selected.protectedRef === undefined ? {} : { protectedRef: selected.protectedRef }),
    });
    const result = await readNativeCandidateJobInputsFromGit(input.readers.open(target), {
      protectedRef: target.head.protectedRef,
      expectedProtectedHead: target.head.commit,
      candidateCommit: selected.candidateCommit,
      candidateTree: selected.candidateTree,
    }, input.compiler);
    await input.authority.assertCurrent(target);
    return result;
  } catch (error) {
    if (error instanceof CandidateExecutionError) throw error;
    throw new CandidateExecutionError("authoritative candidate job inputs could not be loaded", { cause: error });
  }
}
