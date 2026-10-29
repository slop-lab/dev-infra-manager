import { isDeepStrictEqual } from "node:util";
import {
  CandidateExecutionError,
  executionInputsSchema,
  type ExecutionInputs,
} from "@slop-lab/gs-ci-contracts";
import type { RepositoryAuthority, RepositoryTargetSelector } from "@slop-lab/gs-repository-service";
import { gitCiPolicy } from "./policy.js";

export type ExecutionInputIdentity = {
  readonly namespaceId: string;
  readonly repositoryId: string;
  readonly protectedRef?: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
};

export async function captureExecutionInputs(
  authority: RepositoryAuthority,
  input: ExecutionInputIdentity & { readonly repositories: readonly string[] },
): Promise<ExecutionInputs> {
  const target = await executionTarget(authority, selector(input));
  const repositories = [...new Set([input.repositoryId, ...input.repositories])].sort();
  const policy = gitCiPolicy(target.policy, input.repositoryId);
  if (repositories.some((repositoryId) => !policy.ciRepositoryIds.includes(repositoryId))) {
    throw new CandidateExecutionError("job requests a repository outside its imported CI allowlist");
  }
  const entries = await Promise.all(repositories.map(async (repositoryId) => {
    if (repositoryId === input.repositoryId) {
      return [repositoryId, { commit: input.candidateCommit, tree: input.candidateTree }] as const;
    }
    const dependency = await executionTarget(authority, { namespaceId: input.namespaceId, repositoryId });
    return [repositoryId, { commit: dependency.head.commit, tree: dependency.head.tree }] as const;
  }));
  const inputs = executionInputsSchema.parse(Object.fromEntries(entries));
  await assertExecutionInputsCurrent(authority, { ...input, inputs });
  return inputs;
}

export async function assertExecutionInputsCurrent(
  authority: RepositoryAuthority,
  input: ExecutionInputIdentity & { readonly inputs: ExecutionInputs },
): Promise<void> {
  const target = await executionTarget(authority, selector(input));
  const primary = { commit: input.candidateCommit, tree: input.candidateTree };
  if (!Object.hasOwn(input.inputs, input.repositoryId)
    || !isDeepStrictEqual(input.inputs[input.repositoryId], primary)
    || Object.keys(input.inputs).some((repositoryId) =>
      !gitCiPolicy(target.policy, input.repositoryId).ciRepositoryIds.includes(repositoryId))) {
    throw new CandidateExecutionError("execution repository snapshot is not authorized");
  }
  for (const [repositoryId, snapshot] of Object.entries(input.inputs)) {
    if (repositoryId === input.repositoryId) continue;
    const dependency = await executionTarget(authority, { namespaceId: input.namespaceId, repositoryId });
    if (dependency.head.commit !== snapshot.commit || dependency.head.tree !== snapshot.tree) {
      throw new CandidateExecutionError("execution dependency protected head changed");
    }
  }
  await authority.assertCurrent(target);
}

function selector(input: Pick<ExecutionInputIdentity, "namespaceId" | "repositoryId" | "protectedRef">): RepositoryTargetSelector {
  return {
    namespaceId: input.namespaceId,
    repositoryId: input.repositoryId,
    ...(input.protectedRef === undefined ? {} : { protectedRef: input.protectedRef }),
  };
}

async function executionTarget(authority: RepositoryAuthority, selected: RepositoryTargetSelector) {
  try {
    return await authority.resolve(selected);
  } catch (error) {
    if (error instanceof Error) {
      throw new CandidateExecutionError("execution repository is unavailable", { cause: error });
    }
    throw error;
  }
}
