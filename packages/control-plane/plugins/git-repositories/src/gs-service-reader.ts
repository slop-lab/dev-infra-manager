import { repositoryBranches } from "@slop-lab/gs-repository-contracts";
import type {
  RepositoryReadService,
  RepositoryTarget,
} from "@slop-lab/gs-repository-service";
import type { AuthoritativeNativeRepositoryTarget } from "./authoritative-native-root-target.js";
import {
  assertAdvertisedCommits,
  gitBytes,
  readTreeFile,
  repositoryReadHistoryRefs,
} from "./git-read.js";
import type { RepositoryExtensionContext } from "./plugin-api.js";

export function createGsRepositoryReader(
  context: RepositoryExtensionContext,
  targetProofs: WeakMap<RepositoryTarget, AuthoritativeNativeRepositoryTarget>,
): RepositoryReadService {
  const readBytes: RepositoryReadService["readBytes"] = async (input) => {
    const proof = proofForAccess(targetProofs, input.access.target);
    return gitBytes({
      gitExecutable: context.runtime.gitExecutable,
      gitIdentity: context.runtime.gitIdentity,
      repository: proof.repository,
      signal: input.signal,
      ...(input.standardInput === undefined ? {} : { standardInput: Buffer.from(input.standardInput) }),
    }, input.args, input.maximumBytes);
  };
  return {
    readBytes,
    async assertAdvertisedCommits(input) {
      const proof = proofForAccess(targetProofs, input.access.target);
      const advertisedRefs = [
        ...(input.advertisedRefs ?? []),
        ...await repositoryReadHistoryRefs(context, {
          projectId: input.access.target.selector.namespaceId,
          repositoryId: input.access.target.selector.repositoryId,
        }),
      ];
      await assertAdvertisedCommits({
        gitExecutable: context.runtime.gitExecutable,
        gitIdentity: context.runtime.gitIdentity,
        repository: proof.repository,
        signal: input.signal,
      }, input.commits, Object.keys(repositoryBranches(input.access.target.policy)), advertisedRefs);
    },
    async readTreeFile(input) {
      const proof = proofForAccess(targetProofs, input.access.target);
      return readTreeFile({
        gitExecutable: context.runtime.gitExecutable,
        gitIdentity: context.runtime.gitIdentity,
        repository: proof.repository,
        signal: input.signal,
      }, input.commit, input.path);
    },
    async readRef(access, ref) {
      const bytes = await readBytes({
        access,
        args: ["rev-parse", "--verify", `${ref}^{commit}`],
        signal: AbortSignal.timeout(30_000),
        maximumBytes: 1024,
      });
      return Buffer.from(bytes).toString("utf8").trim();
    },
    async readCommitTree(access, commit) {
      const bytes = await readBytes({
        access,
        args: ["rev-parse", "--verify", `${commit}^{tree}`],
        signal: AbortSignal.timeout(30_000),
        maximumBytes: 1024,
      });
      return Buffer.from(bytes).toString("utf8").trim();
    },
  };
}

function proofForAccess(
  proofs: WeakMap<RepositoryTarget, AuthoritativeNativeRepositoryTarget>,
  target: RepositoryTarget,
): AuthoritativeNativeRepositoryTarget {
  const proof = proofs.get(target);
  if (proof === undefined) throw new GsRepositoryReaderError("repository access target was not issued by this DIM adapter");
  return proof;
}

export class GsRepositoryReaderError extends Error {
  readonly name = "GsRepositoryReaderError";
}
