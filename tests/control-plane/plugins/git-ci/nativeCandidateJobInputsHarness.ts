import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeCandidateRequiredJob } from "../../../../packages/contracts/ci/src/workflow-plugin-api.js";
import type { CandidateGitReader } from "../../../../packages/control-plane/plugins/git-ci/src/candidate-execution-git.js";
import { assertGitVersion, type GitRepositoryRuntime } from "../../../../packages/control-plane/plugins/git-repositories/src/repository.js";
import { git, gitExecutable } from "../../../support/gitCommands.js";

export const nativeRequiredJobs = [
  { name: "source", kind: "ordinary-sysbox" },
  { name: "integration", kind: "qemu" }
] as const satisfies readonly NativeCandidateRequiredJob[];

export type NativeCandidateJobInputsFixture = {
  readonly root: string;
  readonly source: string;
  readonly repositoryPath: string;
  readonly gitRuntime: GitRepositoryRuntime;
  readonly reader: CandidateGitReader;
  readonly input: {
    readonly projectId: string;
    readonly repositoryId: string;
    readonly protectedRef: string;
    readonly expectedProtectedHead: string;
    readonly candidateCommit: string;
    readonly candidateTree: string;
  };
  commit(message: string, stage?: boolean): Promise<NativeCandidateJobInputsFixture["input"]>;
  close(): Promise<void>;
};

export async function nativeCandidateJobInputsFixture(
  objectFormat: "sha1" | "sha256",
  gitReaderExecutable = gitExecutable
): Promise<NativeCandidateJobInputsFixture> {
  const root = await mkdtemp(join(tmpdir(), `dim-native-inputs-${objectFormat}-`));
  const source = join(root, "source");
  const storageRoot = join(root, "storage");
  const repositoryPath = join(storageRoot, "project-a", "source.git");
  await mkdir(join(source, ".dim/ci/jobs"), { recursive: true });
  await writeFile(join(source, ".dim/ci/runner.yml"), nativeRunnerYaml());
  await writeFile(join(source, ".dim/ci/jobs/source.bash"), sourceScript());
  await writeFile(join(source, ".dim/ci/jobs/integration.bash"), integrationScript());
  await git(root, ["init", "--initial-branch=main", `--object-format=${objectFormat}`, source]);
  await git(source, ["config", "user.name", "DIM candidate"]);
  await git(source, ["config", "user.email", "candidate@example.invalid"]);
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "candidate"]);
  await mkdir(join(storageRoot, "project-a"), { recursive: true });
  await git(root, ["clone", "--bare", source, repositoryPath]);
  const gitVersion = (await git(root, ["--version"])).stdout.trim().replace("git version ", "");
  const gitRuntime = { storageRoot, gitExecutable: gitReaderExecutable, gitVersion };
  const reader = { executable: gitReaderExecutable, repositoryPath, identity: await assertGitVersion(gitRuntime) };
  const input = await inputFor(source);
  return {
    root,
    source,
    repositoryPath,
    gitRuntime,
    reader,
    input,
    async commit(message, stage = true) {
      if (stage) await git(source, ["add", "-A"]);
      await git(source, ["commit", "-m", message]);
      await git(root, ["--git-dir", repositoryPath, "fetch", source, "+refs/heads/main:refs/heads/main"]);
      return inputFor(source);
    },
    close: () => rm(root, { recursive: true, force: true })
  };
}

export function nativeRunnerYaml(): string {
  return `jobs:
  source:
    script: .dim/ci/jobs/source.bash
  integration:
    script: .dim/ci/jobs/integration.bash
    runtime: vm
`;
}

export function sourceScript(): string {
  return "set -euo pipefail\nprintf 'source\\n'\n";
}

export function integrationScript(): string {
  return "set -euo pipefail\nprintf 'integration\\n'\n";
}

async function inputFor(source: string): Promise<NativeCandidateJobInputsFixture["input"]> {
  const candidateCommit = (await git(source, ["rev-parse", "HEAD"])).stdout.trim();
  const candidateTree = (await git(source, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
  return {
    projectId: "project-a",
    repositoryId: "source",
    protectedRef: "refs/heads/main",
    expectedProtectedHead: candidateCommit,
    candidateCommit,
    candidateTree
  };
}
