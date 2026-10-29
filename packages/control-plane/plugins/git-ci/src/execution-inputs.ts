import type { ExecutionInputs } from "@slop-lab/gs-ci-contracts";
import {
  assertExecutionInputsCurrent as assertGsExecutionInputsCurrent,
  captureExecutionInputs as captureGsExecutionInputs,
} from "@slop-lab/gs-ci";
import { createDimCiAuthority } from "./preparation.js";
import type { GitCiRuntime } from "./runtime.js";

export async function captureExecutionInputs(
  runtime: GitCiRuntime,
  input: {
    readonly projectId: string;
    readonly repositoryId: string;
    readonly protectedRef?: string;
    readonly candidateCommit: string;
    readonly candidateTree: string;
    readonly repositories: readonly string[];
  },
): Promise<ExecutionInputs> {
  return captureGsExecutionInputs(createDimCiAuthority(runtime), {
    namespaceId: input.projectId,
    repositoryId: input.repositoryId,
    ...(input.protectedRef === undefined ? {} : { protectedRef: input.protectedRef }),
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    repositories: input.repositories,
  });
}

export async function assertExecutionInputsCurrent(
  runtime: GitCiRuntime,
  input: {
    readonly projectId: string;
    readonly repositoryId: string;
    readonly protectedRef?: string;
    readonly candidateCommit: string;
    readonly candidateTree: string;
    readonly inputs: ExecutionInputs;
  },
): Promise<void> {
  await assertGsExecutionInputsCurrent(createDimCiAuthority(runtime), {
    namespaceId: input.projectId,
    repositoryId: input.repositoryId,
    ...(input.protectedRef === undefined ? {} : { protectedRef: input.protectedRef }),
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    inputs: input.inputs,
  });
}
