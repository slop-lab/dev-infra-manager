import { dirname } from "node:path";
import { z } from "zod";
import { assertNativeGitBundleStateActive, readNativeProjectRegistrations,
  type NativeGitBundleState } from "./native-bundle-state.js";
import { CandidateExecutionError } from "./candidate-execution-schema.js";
import { verifyLiveImportedRoot } from "./native-imported-root-verifier.js";
import type { NativeImportedRootPolicy } from "./native-imported-root-policy.js";
import type { NativeProjectRootImportInstalled } from "./native-project-root-import-codec.js";
import type { NativeProjectRootCurrentHead } from "./native-project-root-promotion-state.js";
import type { GitExecutableIdentity } from "./repository.js";

const selectorSchema = z.object({
  projectId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
}).strict().readonly();

export type AuthoritativeNativeCandidateRuntime = {
  readonly activated: () => boolean;
  readonly activationTokenDigest: string;
  readonly expectedGenerationId: string;
  readonly gitExecutable: string;
  readonly gitIdentity: GitExecutableIdentity;
  readonly state: NativeGitBundleState;
};

export type AuthoritativeNativeRootTarget = {
  readonly repository: string;
  readonly currentHead: NativeProjectRootCurrentHead;
  readonly imported: NativeProjectRootImportInstalled & {
    readonly policyFormat: "authoritative-v1";
    readonly policy: NativeImportedRootPolicy;
  };
};

export async function resolveAuthoritativeNativeRootTarget(
  runtime: AuthoritativeNativeCandidateRuntime,
  input: unknown
): Promise<AuthoritativeNativeRootTarget> {
  try {
    if ("stateDirectory" in runtime) {
      throw new CandidateExecutionError("authoritative native runtime cannot override its owned state directory");
    }
    const selector = selectorSchema.safeParse(input);
    if (!selector.success) {
      throw new CandidateExecutionError("authoritative native root selector is invalid", { cause: selector.error });
    }
    const registration = readNativeProjectRegistrations(runtime.state)
      .find((entry) => entry.projectId === selector.data.projectId);
    if (registration === undefined) {
      throw new CandidateExecutionError("authoritative native Project is not registered");
    }
    const { imported, currentHead, repository } = await verifyLiveImportedRoot({
      activated: runtime.activated(),
      activationTokenDigest: runtime.activationTokenDigest,
      expectedGenerationId: runtime.expectedGenerationId,
      gitExecutable: runtime.gitExecutable,
      gitIdentity: runtime.gitIdentity,
      ownerHostId: registration.ownerHostId,
      projectId: selector.data.projectId,
      state: runtime.state,
      stateDirectory: dirname(runtime.state.database)
    });
    if (imported.policyFormat !== "authoritative-v1") {
      throw new CandidateExecutionError("legacy imported-root policy cannot authorize native root access");
    }
    assertNativeGitBundleStateActive(runtime.state);
    return { imported, currentHead, repository };
  } catch (error) {
    if (error instanceof CandidateExecutionError) throw error;
    throw new CandidateExecutionError("authoritative native root target could not be resolved", { cause: error });
  }
}
