import { gitCiPolicy } from "./policy.js";
import type { GitCiRuntime } from "./runtime.js";
import { isDeepStrictEqual } from "node:util";
import { CandidateExecutionError, executionInputsSchema, type ExecutionInputs } from "@slop-lab/dim-contracts-ci/descriptor";
import { resolveAuthoritativeNativeRepositoryTarget, AuthoritativeRepositoryError } from "@slop-lab/dim-control-plane-plugin-git-repositories/plugin-api";

/** Resolve candidate-requested repositories only inside the imported, trusted allowlist. */
export async function captureExecutionInputs(runtime: GitCiRuntime,
  input: { projectId: string; repositoryId: string; candidateCommit: string; candidateTree: string; repositories: readonly string[] }): Promise<ExecutionInputs> {
  const target = await executionTarget(runtime, inputSelector(input));
  const repositories = [...new Set([input.repositoryId, ...input.repositories])].sort();
  if (repositories.some((id) => !gitCiPolicy(target.imported.policy, input.repositoryId).ciRepositoryIds.includes(id))) {
    throw new CandidateExecutionError("job requests a repository outside its imported CI allowlist");
  }
  const entries = await Promise.all(repositories.map(async (repositoryId) => {
    if (repositoryId === input.repositoryId) return [repositoryId, { commit: input.candidateCommit, tree: input.candidateTree }] as const;
    const dependency = await executionTarget(runtime, { projectId: input.projectId, repositoryId });
    return [repositoryId, { commit: dependency.currentHead.commit, tree: dependency.currentHead.tree }] as const;
  }));
  const inputs = executionInputsSchema.parse(Object.fromEntries(entries));
  await assertExecutionInputsCurrent(runtime, { ...input, inputs });
  return inputs;
}

/** Frozen dependencies stay pinned; moved protected heads require a new integration snapshot. */
export async function assertExecutionInputsCurrent(runtime: GitCiRuntime,
  input: { projectId: string; repositoryId: string; candidateCommit: string; candidateTree: string; inputs: ExecutionInputs }): Promise<void> {
  const target = await executionTarget(runtime, inputSelector(input));
  if (!Object.hasOwn(input.inputs, input.repositoryId) || !isDeepStrictEqual(input.inputs[input.repositoryId], { commit: input.candidateCommit, tree: input.candidateTree })
    || Object.keys(input.inputs).some((id) => !gitCiPolicy(target.imported.policy, input.repositoryId).ciRepositoryIds.includes(id))) {
    throw new CandidateExecutionError("execution repository snapshot is not authorized");
  }
  for (const [repositoryId, snapshot] of Object.entries(input.inputs)) {
    if (repositoryId === input.repositoryId) continue;
    const dependency = await executionTarget(runtime, { projectId: input.projectId, repositoryId });
    if (dependency.currentHead.commit !== snapshot.commit || dependency.currentHead.tree !== snapshot.tree) {
      throw new CandidateExecutionError("execution dependency protected head changed");
    }
  }
}
function inputSelector(input: { projectId: string; repositoryId: string }) { return { projectId: input.projectId, repositoryId: input.repositoryId }; }

async function executionTarget(runtime: GitCiRuntime, selector: { projectId: string; repositoryId: string }) {
  try { return await resolveAuthoritativeNativeRepositoryTarget(runtime, selector); }
  catch (error) {
    if (error instanceof AuthoritativeRepositoryError) throw new CandidateExecutionError("execution repository is unavailable", { cause: error });
    throw error;
  }
}
