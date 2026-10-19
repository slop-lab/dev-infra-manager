import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openNativeGitCandidateReadAuthority, type NativeGitReaderLimits } from "../../../../packages/host/plugins/ci-worker/src/nativeGitCandidateReadAuthority.js";
import {
  gitHttpFixture,
  type GitHttpFixture,
  type GitObjectFormat
} from "../../../support/gitHttpFixture.js";

export type CandidateReadFixture = {
  readonly native: GitHttpFixture;
  close(): Promise<void>;
  readonly clone: string;
  readonly temporaryRoot: string;
  readonly destinationParent: string;
  readonly initialHead: string;
  commitFile(path: string, bytes: string): Promise<{ readonly commit: string; readonly tree: string }>;
  push(commit: string, name: string): Promise<void>;
  authority(candidate: { readonly commit: string; readonly tree: string }, limits?: Partial<NativeGitReaderLimits>): ReturnType<typeof openNativeGitCandidateReadAuthority>;
};

export async function candidateReadFixture(objectFormat: GitObjectFormat = "sha1"): Promise<CandidateReadFixture> {
  const native = await gitHttpFixture(objectFormat);
  const clone = join(native.root, "candidate-writer");
  const temporaryRoot = join(native.root, "candidate-reader-temp");
  const destinationParent = join(native.root, "candidate-destinations");
  await native.git(native.root, ["clone", native.url("project-a", "source"), clone]);
  await native.git(clone, ["config", "user.name", "DIM writer"]);
  await native.git(clone, ["config", "user.email", "writer@example.invalid"]);
  await mkdir(temporaryRoot, { mode: 0o700 });
  await mkdir(destinationParent, { mode: 0o700 });
  const initialHead = (await native.git(clone, ["rev-parse", "HEAD"])).stdout.trim();
  const readers: ReturnType<typeof openNativeGitCandidateReadAuthority>[] = [];
  return {
    native,
    async close() { await Promise.all(readers.map((reader) => reader.close())); await native.close(); },
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
      const reader = openNativeGitCandidateReadAuthority({
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
      readers.push(reader); return reader;
    }
  };
}
