import { dirname } from "node:path";
import { z } from "zod";
import { assertNativeGitBundleStateActive, readNativeProjectRegistrations,
  type NativeGitBundleState } from "./native-bundle-state.js";
import { CandidateExecutionError } from "@slop-lab/dim-contracts-ci/descriptor";
import { verifyLiveImportedRepository } from "./native-imported-root-verifier.js";
import type { NativeProjectRootImportInstalled } from "./native-project-root-import-codec.js";
import type { NativeProjectRootCurrentHead } from "./native-project-root-promotion-state.js";
import type { GitExecutableIdentity } from "./repository.js";

const selectorSchema = z.object({
  projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
}).strict().readonly();

import type { WorkflowCompiler } from "@slop-lab/dim-contracts-ci/workflow";

export type AuthoritativeNativeCandidateRuntime = {
  readonly workflowCompiler: WorkflowCompiler;
  readonly activated: () => boolean;
  readonly activationTokenDigest: string;
  readonly expectedGenerationId: string;
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly state: NativeGitBundleState;
};

export type AuthoritativeNativeRepositoryTarget = {
  readonly repository: string;
  readonly currentHead: NativeProjectRootCurrentHead;
  readonly imported: NativeProjectRootImportInstalled;
};

export async function resolveAuthoritativeNativeRepositoryTarget(
  runtime: AuthoritativeNativeCandidateRuntime,
  input: unknown
): Promise<AuthoritativeNativeRepositoryTarget> {
  try {
    if ("stateDirectory" in runtime) {
      throw new CandidateExecutionError("authoritative native runtime cannot override its owned state directory");
    }
    const selector = selectorSchema.safeParse(input);
    if (!selector.success) {
      throw new CandidateExecutionError("authoritative native root selector is invalid", { cause: selector.error });
    }
    const registration = readNativeProjectRegistrations(runtime.state)
      .find((entry) => entry.projectId === selector.data.projectId && entry.repositoryId === selector.data.repositoryId);
    if (registration === undefined) {
      throw new CandidateExecutionError("authoritative native Project is not registered");
    }
    const { imported, currentHead, repository } = await verifyLiveImportedRepository({
      activated: runtime.activated(),
      activationTokenDigest: runtime.activationTokenDigest,
      expectedGenerationId: runtime.expectedGenerationId,
      gitExecutable: runtime.gitExecutable,
      gitIdentity: runtime.gitIdentity,
      ownerHostId: registration.ownerHostId,
      projectId: selector.data.projectId,
      repositoryId: selector.data.repositoryId,
      state: runtime.state,
      stateDirectory: dirname(runtime.state.database)
    });
    assertNativeGitBundleStateActive(runtime.state);
    return { imported, currentHead, repository };
  } catch (error) {
    if (error instanceof CandidateExecutionError) throw error;
    throw new CandidateExecutionError("authoritative native root target could not be resolved", { cause: error });
  }
}
