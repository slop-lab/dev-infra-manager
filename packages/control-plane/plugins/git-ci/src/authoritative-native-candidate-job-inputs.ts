import { z } from "zod";
import { CandidateExecutionError } from "@slop-lab/gs-ci-contracts";
import {
  loadCandidateJobInputs,
  type NativeCandidateJobInputs,
} from "@slop-lab/gs-ci";
import { createDimCiAuthority } from "./preparation.js";
import type { GitCiRuntime } from "./runtime.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const selectorSchema = z.object({
  projectId: identifier,
  repositoryId: identifier,
  protectedRef: z.string().startsWith("refs/heads/").optional(),
  candidateCommit: objectId,
  candidateTree: objectId,
}).strict().readonly();

export type AuthoritativeNativeCandidateJobSelector = z.infer<typeof selectorSchema>;
export type { GitCiRuntime } from "./runtime.js";

export async function loadAuthoritativeNativeCandidateJobInputs(
  runtime: GitCiRuntime,
  input: unknown,
): Promise<NativeCandidateJobInputs> {
  const parsed = selectorSchema.safeParse(input);
  if (!parsed.success) {
    throw new CandidateExecutionError("authoritative candidate selector is invalid", { cause: parsed.error });
  }
  const selector = parsed.data;
  return loadCandidateJobInputs({
    authority: createDimCiAuthority(runtime),
    readers: {
      open: (target) => ({
        executable: runtime.gitExecutable,
        repositoryPath: target.repositoryPath,
        identity: runtime.gitIdentity,
      }),
    },
    compiler: runtime.workflowCompiler,
    selector: {
      namespaceId: selector.projectId,
      repositoryId: selector.repositoryId,
      ...(selector.protectedRef === undefined ? {} : { protectedRef: selector.protectedRef }),
      candidateCommit: selector.candidateCommit,
      candidateTree: selector.candidateTree,
    },
  });
}
