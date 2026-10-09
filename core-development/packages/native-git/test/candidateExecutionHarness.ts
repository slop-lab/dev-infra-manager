import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  parseNativeGitServiceConfig,
  type CandidateOrdinaryExecutionRequest,
  type NativeGitServiceConfig
} from "../../../../core/packages/native-git/src/index.js";

const execute = promisify(execFile);
export const gitExecutable = "/usr/bin/git";
export const imageDigest = `registry.example/ci@sha256:${"1".repeat(64)}`;
export const runnerBaseImageDigest = `registry.example/runner@sha256:${"2".repeat(64)}`;

export type CandidateExecutionFixture = {
  readonly root: string;
  readonly source: string;
  readonly repositoryPath: string;
  readonly config: NativeGitServiceConfig;
  readonly request: CandidateOrdinaryExecutionRequest;
  commit(message: string): Promise<CandidateOrdinaryExecutionRequest>;
  close(): Promise<void>;
};

export async function candidateExecutionFixture(): Promise<CandidateExecutionFixture> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-candidate-execution-"));
  const source = join(root, "source");
  const storageRoot = join(root, "storage");
  const repositoryPath = join(storageRoot, "project-a", "source.git");
  await mkdir(join(source, ".dim/ci/jobs"), { recursive: true });
  await writeFile(join(source, ".dim/ci/runner.yml"), validRunnerYaml());
  await writeFile(join(source, ".dim/ci/jobs/source.bash"), "set -euo pipefail\nprintf 'verified\\n'\n");
  await git(root, ["init", "--initial-branch=main", source]);
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
    gitExecutable,
    gitVersion,
    repositories: [{
      projectId: "project-a",
      repositoryId: "source",
      reviewPolicies: [{
        protectedRef: "refs/heads/main",
        policyRevision: "policy-1",
        requiredReviewRevision: "review-1",
        requiredJobSetRevision: "jobs-1",
        requiredJobNames: ["source"],
        requiredReviewerIds: ["owner"]
      }]
    }],
    identities: [
      { role: "reviewer", username: "owner", password: "owner-secret-value", projectId: "project-a", repositoryIds: ["source"], reviewerId: "owner" }
    ]
  });
  const request = await requestFor(source);
  return {
    root,
    source,
    repositoryPath,
    config,
    request,
    async commit(message) {
      await git(source, ["add", "-A"]);
      await git(source, ["commit", "-m", message]);
      await git(root, ["--git-dir", repositoryPath, "fetch", source, "+refs/heads/main:refs/heads/main"]);
      return requestFor(source);
    },
    close: () => rm(root, { recursive: true, force: true })
  };
}

export function validRunnerYaml(): string {
  return `schemaVersion: 3
ordinary:
  jobs:
    source:
      script: .dim/ci/jobs/source.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
`;
}

export async function replaceScriptWithSymlink(fixture: CandidateExecutionFixture): Promise<void> {
  await rm(join(fixture.source, ".dim/ci/jobs/source.bash"));
  await symlink("../../runner.yml", join(fixture.source, ".dim/ci/jobs/source.bash"));
}

export async function git(
  cwd: string,
  args: readonly string[]
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return execute(gitExecutable, [...args], {
    cwd,
    env: { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10_000
  });
}

export async function gitInput(
  cwd: string,
  args: readonly string[],
  input: Buffer
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(gitExecutable, [...args], {
      cwd,
      env: { GIT_CONFIG_NOSYSTEM: "1", HOME: "/dev/null", LC_ALL: "C" },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10_000
    }, (error, stdout, stderr) => {
      if (error !== null) {
        Reflect.set(error, "stderr", stderr);
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

export async function forgedCandidateWithAncestor(
  fixture: CandidateExecutionFixture,
  mode: "120000" | "160000"
): Promise<CandidateOrdinaryExecutionRequest> {
  const configObjectId = (await git(fixture.root, ["--git-dir", fixture.repositoryPath, "rev-parse", `${fixture.request.candidateTree}:.dim/ci/runner.yml`])).stdout.trim();
  const scriptObjectId = (await git(fixture.root, ["--git-dir", fixture.repositoryPath, "rev-parse", `${fixture.request.candidateTree}:.dim/ci/jobs/source.bash`])).stdout.trim();
  const ancestorObjectId = mode === "160000"
    ? fixture.request.candidateCommit
    : (await gitInput(fixture.root, ["--git-dir", fixture.repositoryPath, "hash-object", "-w", "--stdin"], Buffer.from("ci"))).stdout.trim();
  const tree = await writeRawTree(fixture.root, ["--git-dir", fixture.repositoryPath], [
    { mode, name: ".dim", objectId: ancestorObjectId },
    { mode: "100644", name: ".dim/ci/jobs/source.bash", objectId: scriptObjectId },
    { mode: "100644", name: ".dim/ci/runner.yml", objectId: configObjectId }
  ]);
  const candidateCommit = (await git(fixture.root, [
    "--git-dir", fixture.repositoryPath,
    "-c", "user.name=DIM attacker",
    "-c", "user.email=attacker@example.invalid",
    "commit-tree", tree, "-p", fixture.request.candidateCommit, "-m", "forged candidate"
  ])).stdout.trim();
  return { ...fixture.request, candidateCommit, candidateTree: tree };
}

export async function writeRawTree(
  cwd: string,
  gitPrefix: readonly string[],
  entries: readonly { readonly mode: string; readonly name: string; readonly objectId: string }[]
): Promise<string> {
  const bytes = entries
    .toSorted((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))
    .flatMap((entry) => [
      Buffer.from(`${entry.mode} ${entry.name}\0`),
      Buffer.from(entry.objectId, "hex")
    ]);
  return (await gitInput(cwd, [...gitPrefix, "hash-object", "--literally", "-t", "tree", "-w", "--stdin"], Buffer.concat(bytes))).stdout.trim();
}

async function requestFor(source: string): Promise<CandidateOrdinaryExecutionRequest> {
  const candidateCommit = (await git(source, ["rev-parse", "HEAD"])).stdout.trim();
  const candidateTree = (await git(source, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
  return {
    projectId: "project-a",
    repositoryId: "source",
    protectedRef: "refs/heads/main",
    expectedProtectedHead: candidateCommit,
    candidateCommit,
    candidateTree,
    policyRevision: "policy-1",
    requiredReviewRevision: "review-1",
    requiredJobSetRevision: "jobs-1",
    admissionGeneration: "generation-1",
    jobName: "source",
    jobBaseImage: imageDigest,
    runnerBaseImage: runnerBaseImageDigest,
    bounds: {
      cpu: "2",
      memoryBytes: "2147483648",
      pids: "512",
      wallClockSeconds: "900",
      outputBytes: "10485760"
    }
  };
}
