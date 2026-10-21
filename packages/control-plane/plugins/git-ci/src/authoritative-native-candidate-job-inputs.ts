import type { GitCiRuntime } from "./runtime.js";
import { z } from "zod";
import { resolveAuthoritativeNativeRepositoryTarget } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";
import { CandidateExecutionError } from "@slop-lab/dim-contracts-ci/descriptor";
import {
  readNativeCandidateJobInputsFromGit,
  type NativeCandidateJobInputs
} from "./native-candidate-job-inputs.js";

const identifier = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const selectorSchema = z.object({
  projectId: identifier,
  repositoryId: identifier,
  candidateCommit: objectId,
  candidateTree: objectId
}).strict().readonly();

export type AuthoritativeNativeCandidateJobSelector = z.infer<typeof selectorSchema>;

export type { GitCiRuntime } from "./runtime.js";

export async function loadAuthoritativeNativeCandidateJobInputs(
  runtime: GitCiRuntime,
  input: unknown
): Promise<NativeCandidateJobInputs> {
  try {
    const selector = selectorSchema.safeParse(input);
    if (!selector.success) {
      throw new CandidateExecutionError("authoritative native candidate selector is invalid", {
        cause: selector.error
      });
    }
    const verified = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: selector.data.projectId, repositoryId: selector.data.repositoryId });
    const target = {
      protectedRef: verified.currentHead.protectedRef,
      expectedProtectedHead: verified.currentHead.commit,
      candidateCommit: selector.data.candidateCommit,
      candidateTree: selector.data.candidateTree
    };
    const result = await readNativeCandidateJobInputsFromGit(
      {
        executable: runtime.gitExecutable,
        repositoryPath: verified.repository,
        identity: runtime.gitIdentity
      },
      target,
      runtime.workflowCompiler
    );
    const current = await resolveAuthoritativeNativeRepositoryTarget(runtime, { projectId: selector.data.projectId, repositoryId: selector.data.repositoryId });
    if (current.repository !== verified.repository
      || JSON.stringify(current.imported) !== JSON.stringify(verified.imported)
      || JSON.stringify(current.currentHead) !== JSON.stringify(verified.currentHead)) {
      throw new CandidateExecutionError("authoritative imported repository changed during candidate read");
    }
    return result;
  } catch (error) {
    if (error instanceof CandidateExecutionError) throw error;
    throw new CandidateExecutionError("authoritative native candidate job inputs could not be loaded", {
      cause: error
    });
  }
}
