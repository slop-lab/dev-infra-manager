import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNativeGitCandidateReadAuthority, type NativeGitReaderLimits } from "../../../../core/packages/core/src/nativeGitCandidateReadAuthority.js";
import {
  nativeGitFixture,
  type NativeGitFixture,
  type NativeGitObjectFormat
} from "../../native-git/test/nativeGitHarness.js";

export type CandidateReadFixture = {
  readonly native: NativeGitFixture;
  readonly clone: string;
  readonly temporaryRoot: string;
  readonly destinationParent: string;
  readonly initialHead: string;
  commitFile(path: string, bytes: string): Promise<{ readonly commit: string; readonly tree: string }>;
  push(commit: string, name: string): Promise<void>;
  authority(candidate: { readonly commit: string; readonly tree: string }, limits?: Partial<NativeGitReaderLimits>): ReturnType<typeof createNativeGitCandidateReadAuthority>;
};

export async function candidateReadFixture(objectFormat: NativeGitObjectFormat = "sha1"): Promise<CandidateReadFixture> {
  const native = await nativeGitFixture(objectFormat);
  const clone = join(native.root, "candidate-writer");
  const temporaryRoot = join(native.root, "candidate-reader-temp");
  const destinationParent = join(native.root, "candidate-destinations");
  await native.git(native.root, ["clone", native.url("writer-a", "writer-a-secret-1", "project-a", "source"), clone]);
  await native.git(clone, ["config", "user.name", "DIM writer"]);
  await native.git(clone, ["config", "user.email", "writer@example.invalid"]);
  await mkdir(temporaryRoot, { mode: 0o700 });
  await mkdir(destinationParent, { mode: 0o700 });
  const initialHead = (await native.git(clone, ["rev-parse", "HEAD"])).stdout.trim();
  return {
    native,
    clone,
    temporaryRoot,
    destinationParent,
    initialHead,
    async commitFile(path, bytes) {
      const parent = join(clone, ...path.split("/").slice(0, -1));
      await mkdir(parent, { recursive: true });
      await writeFile(join(clone, path), bytes);
      await native.git(clone, ["add", "--", path]);
      await native.git(clone, ["commit", "-m", path]);
      return {
        commit: (await native.git(clone, ["rev-parse", "HEAD"])).stdout.trim(),
        tree: (await native.git(clone, ["rev-parse", "HEAD^{tree}"])).stdout.trim()
      };
    },
    async push(commit, name) {
      await native.git(clone, ["push", "origin", `${commit}:refs/heads/proposals/workspace-a/${name}`]);
    },
    authority(candidate, limits) {
      return createNativeGitCandidateReadAuthority({
        gitExecutable: native.config.gitExecutable,
        serviceEndpoint: native.baseUrl,
        credential: { username: "reader-a", password: "reader-a-secret-1" },
        temporaryRoot,
        claim: {
          projectId: "project-a",
          repositoryId: "source",
          protectedRef: "refs/heads/main",
          expectedProtectedHead: initialHead,
          candidateCommit: candidate.commit,
          candidateTree: candidate.tree
        },
        ...(limits === undefined ? {} : { limits })
      });
    }
  };
}
