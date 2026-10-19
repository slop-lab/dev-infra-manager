import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { NativeGitBundleState } from "./native-bundle-state.js";
import { atomicPromote } from "./promotion-git.js";
import {
  finalizeNativeProjectRootPromotion,
  readNativeProjectRootPromotionIntents
} from "./native-project-root-promotion-state.js";

const execute = promisify(execFile);

export async function recoverNativeProjectRootPromotions(input: {
  readonly gitExecutable: string;
  readonly state: NativeGitBundleState;
  readonly stateDirectory: string;
}): Promise<void> {
  for (const intent of readNativeProjectRootPromotionIntents(input.state.database)) {
    const repository = join(input.stateDirectory, intent.projectId, `${intent.repositoryId}.git`);
    const current = (await execute(input.gitExecutable,
      ["--git-dir", repository, "rev-parse", intent.protectedRef], { env: gitEnvironment() })).stdout.trim();
    if (current === intent.expectedCommit) {
      const updated = await atomicPromote({ gitExecutable: input.gitExecutable, storageRoot: input.stateDirectory },
        { projectId: intent.projectId, repositoryId: intent.repositoryId, protectedRef: intent.protectedRef,
          proposalRef: intent.proposalRef }, intent.expectedCommit, intent.candidateCommit);
      if (!updated) throw new NativeProjectRootPromotionRecoveryError("promotion recovery compare-and-swap failed");
    } else if (current !== intent.candidateCommit) {
      throw new NativeProjectRootPromotionRecoveryError("promotion recovery found a foreign protected head");
    }
    finalizeNativeProjectRootPromotion(input.state.database, intent);
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" };
}

export class NativeProjectRootPromotionRecoveryError extends Error {
  readonly name = "NativeProjectRootPromotionRecoveryError";
}
