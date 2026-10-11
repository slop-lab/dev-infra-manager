import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseNativeGitServiceConfig,
  type NativeCandidateRequiredJob,
  type NativeGitServiceConfig
} from "../../../../core/packages/native-git/src/index.js";
import { git, gitExecutable } from "./candidateExecutionHarness.js";

export const nativeRequiredJobs = [
  { name: "source", kind: "ordinary-sysbox" },
  { name: "integration", kind: "qemu" }
] as const satisfies readonly NativeCandidateRequiredJob[];

export type NativeCandidateJobInputsFixture = {
  readonly root: string;
  readonly source: string;
  readonly repositoryPath: string;
  readonly config: NativeGitServiceConfig;
  readonly input: {
    readonly projectId: string;
    readonly repositoryId: string;
    readonly protectedRef: string;
    readonly expectedProtectedHead: string;
    readonly candidateCommit: string;
    readonly candidateTree: string;
    readonly requiredJobs: readonly NativeCandidateRequiredJob[];
  };
  commit(message: string): Promise<NativeCandidateJobInputsFixture["input"]>;
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
  const config = parseNativeGitServiceConfig({
    schemaVersion: 2,
    serviceId: "native-main",
    host: "127.0.0.1",
    port: 0,
    storageRoot,
    gitExecutable: gitReaderExecutable,
    gitVersion,
    repositories: [{
      projectId: "project-a",
      repositoryId: "source",
      reviewPolicies: [{
        protectedRef: "refs/heads/main",
        policyRevision: "policy-1",
        requiredReviewRevision: "review-1",
        requiredJobSetRevision: "jobs-1",
        requiredJobNames: ["source", "integration"],
        requiredReviewerIds: ["owner"]
      }]
    }],
    identities: [
      { role: "reviewer", username: "owner", password: "owner-secret-value", projectId: "project-a", repositoryIds: ["source"], reviewerId: "owner" }
    ]
  });
  const input = await inputFor(source);
  return {
    root,
    source,
    repositoryPath,
    config,
    input,
    async commit(message) {
      await git(source, ["add", "-A"]);
      await git(source, ["commit", "-m", message]);
      await git(root, ["--git-dir", repositoryPath, "fetch", source, "+refs/heads/main:refs/heads/main"]);
      return inputFor(source);
    },
    close: () => rm(root, { recursive: true, force: true })
  };
}

export function nativeRunnerYaml(): string {
  return `schemaVersion: 4
ordinary:
  jobs:
    source:
      script: .dim/ci/jobs/source.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
qemu:
  jobs:
    integration:
      script: .dim/ci/jobs/integration.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
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
    candidateTree,
    requiredJobs: nativeRequiredJobs
  };
}
