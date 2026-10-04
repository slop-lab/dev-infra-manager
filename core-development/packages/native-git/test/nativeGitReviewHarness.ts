import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createNativeGitServer,
  initializeNativeRepository,
  parseNativeGitServiceConfig,
  type NativeGitServer,
  type NativeGitServiceConfig
} from "../../../../core/packages/native-git/src/index.js";
import { createGitReadGate, type GitReadGate } from "./gitReadGate.js";

const run = promisify(execFile);
const gitExecutable = "/usr/bin/git";

export type ReviewFixture = {
  readonly root: string;
  readonly baseUrl: () => string;
  readonly repositoryPath: string;
  readonly config: NativeGitServiceConfig;
  readonly proposalRef: string;
  readonly protectedHead: string;
  readonly configWithPolicyRevision: (revision: string) => NativeGitServiceConfig;
  readonly configWithIdentityUsername: (username: string, replacement: string) => NativeGitServiceConfig;
  readonly request: (identity: string, method: string, path: string, body?: unknown) => Promise<Response>;
  readonly git: (cwd: string, args: readonly string[]) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly clone: string;
  readonly candidateReadGate: GitReadGate;
  restart(config?: NativeGitServiceConfig): Promise<void>;
  close(): Promise<void>;
};

export type JsonObject = Readonly<Record<string, unknown>>;

export async function nativeGitReviewFixture(): Promise<ReviewFixture> {
  const root = await mkdtemp(join(tmpdir(), "dim-native-git-review-"));
  const storageRoot = join(root, "storage");
  const candidateReadGate = await createGitReadGate(root, gitExecutable);
  const repository = {
    projectId: "project-a",
    repositoryId: "source",
    reviewPolicies: [{
      protectedRef: "refs/heads/main",
      policyRevision: "policy-1",
      requiredReviewRevision: "review-1",
      requiredJobSetRevision: "jobs-1",
      requiredJobNames: ["source", "security"],
      requiredReviewerIds: ["reviewer-a"],
      pathReviewerRules: [{ pathPrefix: "docs/", reviewerIds: ["docs-reviewer"] }]
    }]
  };
  const configInput = {
    schemaVersion: 1,
    host: "127.0.0.1",
    port: 0,
    storageRoot,
    gitExecutable: candidateReadGate.executable,
    gitVersion: "2.43.0",
    repositories: [repository, { projectId: "project-b", repositoryId: "source" }],
    identities: [
      { role: "reader", username: "ci-a", password: "ci-a-secret-value", projectId: "project-a", repositoryIds: ["source"] },
      { role: "ci", username: "source-ci", password: "source-ci-secret", projectId: "project-a", repositoryIds: ["source"], jobName: "source" },
      { role: "ci", username: "security-ci", password: "security-ci-secret", projectId: "project-a", repositoryIds: ["source"], jobName: "security" },
      { role: "ci", username: "foreign-ci", password: "foreign-ci-secret", projectId: "project-b", repositoryIds: ["source"], jobName: "source" },
      { role: "scheduler", username: "scheduler-a", password: "scheduler-a-secret", projectId: "project-a", repositoryIds: ["source"] },
      { role: "promoter", username: "promoter-a", password: "promoter-a-secret", projectId: "project-a", repositoryIds: ["source"] },
      { role: "writer", username: "writer-a", password: "writer-a-secret-1", projectId: "project-a", repositoryIds: ["source"], workspaceId: "workspace-a" },
      { role: "reviewer", username: "reviewer-a-user", password: "reviewer-a-secret", projectId: "project-a", repositoryIds: ["source"], reviewerId: "reviewer-a" },
      { role: "reviewer", username: "docs-reviewer-user", password: "docs-reviewer-secret", projectId: "project-a", repositoryIds: ["source"], reviewerId: "docs-reviewer" },
      { role: "administrator", username: "admin-a", password: "admin-a-secret-1", projectId: "project-a", repositoryIds: ["source"] },
      { role: "reviewer", username: "reviewer-b-user", password: "reviewer-b-secret", projectId: "project-b", repositoryIds: ["source"], reviewerId: "reviewer-b" }
    ]
  };
  let config: NativeGitServiceConfig;
  try {
    config = parseNativeGitServiceConfig(configInput);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const repositoryPath = await initializeNativeRepository(config, repository);
  const projectB = config.repositories.find((candidate) => candidate.projectId === "project-b");
  if (projectB === undefined) throw new Error("review fixture requires project-b");
  await initializeNativeRepository(config, projectB);
  const source = join(root, "source");
  await run(gitExecutable, ["init", "--initial-branch=main", source]);
  await run(gitExecutable, ["-C", source, "config", "user.name", "DIM writer"]);
  await run(gitExecutable, ["-C", source, "config", "user.email", "writer@example.invalid"]);
  await writeFile(join(source, "README.md"), "initial\n");
  await writeFile(join(source, "obsolete.txt"), "remove me\n");
  await writeFile(join(source, "mode.sh"), "#!/bin/sh\nexit 0\n");
  await mkdir(join(source, ".dim/ci/jobs"), { recursive: true });
  await writeFile(join(source, ".dim/ci/runner.yml"), `schemaVersion: 2
ordinary:
  jobs:
    source:
      image: registry.example/source@sha256:${"1".repeat(64)}
      script: .dim/ci/jobs/source.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
    security:
      image: registry.example/security@sha256:${"2".repeat(64)}
      script: .dim/ci/jobs/security.bash
      argv: [/bin/bash, --noprofile, --norc, /run/dim/job/script]
`);
  await writeFile(join(source, ".dim/ci/jobs/source.bash"), "set -euo pipefail\nprintf 'source verified\\n'\n");
  await writeFile(join(source, ".dim/ci/jobs/security.bash"), "set -euo pipefail\nprintf 'security verified\\n'\n");
  await symlink("README.md", join(source, "documentation"));
  await run(gitExecutable, ["-C", source, "add", "."]);
  await run(gitExecutable, ["-C", source, "commit", "-m", "initial"]);
  await run(gitExecutable, ["--git-dir", repositoryPath, "fetch", source, "refs/heads/main:refs/heads/main"]);
  await run(gitExecutable, ["--git-dir", repositoryPath, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const protectedHead = (await run(gitExecutable, ["--git-dir", repositoryPath, "rev-parse", "refs/heads/main"])).stdout.trim();

  let service: NativeGitServer = createNativeGitServer(config);
  let endpoint = await service.listen();
  const clone = join(root, "writer-clone");
  await git(root, ["clone", authenticatedGitUrl(endpoint), clone]);
  await git(clone, ["config", "user.name", "DIM writer"]);
  await git(clone, ["config", "user.email", "writer@example.invalid"]);
  await mkdir(join(clone, "docs"));
  await git(clone, ["mv", "README.md", "docs/README.md"]);
  await git(clone, ["rm", "obsolete.txt", "documentation"]);
  await writeFile(join(clone, "added.txt"), "added\n");
  await symlink("docs/README.md", join(clone, "documentation"));
  await chmod(join(clone, "mode.sh"), 0o755);
  await git(clone, ["add", "."]);
  await git(clone, ["commit", "-m", "complete candidate"]);
  const proposalRef = "refs/heads/proposals/workspace-a/change-1";
  await git(clone, ["push", "origin", `HEAD:${proposalRef}`]);

  return {
    root,
    baseUrl: () => endpoint,
    repositoryPath,
    config,
    proposalRef,
    protectedHead,
    configWithPolicyRevision: (revision) => parseNativeGitServiceConfig({
      ...configInput,
      repositories: [{
        ...repository,
        reviewPolicies: repository.reviewPolicies.map((policy) => ({ ...policy, policyRevision: revision }))
      }, { projectId: "project-b", repositoryId: "source" }]
    }),
    configWithIdentityUsername: (username, replacement) => parseNativeGitServiceConfig({
      ...configInput,
      identities: configInput.identities.map((identity) => identity.username === username
        ? { ...identity, username: replacement }
        : identity)
    }),
    clone,
    candidateReadGate,
    git,
    request: (identity, method, path, body) => reviewRequest(endpoint, identity, method, path, body),
    async restart(nextConfig = config) {
      await service.close();
      service = createNativeGitServer(nextConfig);
      endpoint = await service.listen();
    },
    async close() {
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

export function reviewPath(suffix = ""): string {
  return `/v1/projects/project-a/repositories/source/reviews${suffix}`;
}

export async function readJsonObject(response: Response): Promise<JsonObject> {
  return parseJsonObject(await response.text());
}

export function parseJsonObject(input: string): JsonObject {
  const value: unknown = JSON.parse(input);
  if (!isJsonObject(value)) throw new Error("expected JSON object");
  return value;
}

export function stringField(value: JsonObject, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`expected string field: ${field}`);
  return candidate;
}

export function stringArrayField(value: JsonObject, field: string): readonly string[] {
  const candidate = value[field];
  if (!Array.isArray(candidate) || !candidate.every((entry) => typeof entry === "string")) {
    throw new Error(`expected string array field: ${field}`);
  }
  return candidate;
}

export function objectArrayField(value: JsonObject, field: string): readonly JsonObject[] {
  const candidate = value[field];
  if (!Array.isArray(candidate) || !candidate.every(isJsonObject)) {
    throw new Error(`expected object array field: ${field}`);
  }
  return candidate;
}

export function objectField(value: JsonObject, field: string): JsonObject {
  const candidate = value[field];
  if (!isJsonObject(candidate)) throw new Error(`expected object field: ${field}`);
  return candidate;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function git(cwd: string, args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return run(gitExecutable, [...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  });
}

function authenticatedGitUrl(baseUrl: string): string {
  return `${baseUrl.replace("http://", "http://writer-a:writer-a-secret-1@")}/v1/projects/project-a/repositories/source.git`;
}

async function reviewRequest(baseUrl: string, identity: string, method: string, path: string, body?: unknown): Promise<Response> {
  const passwords: Readonly<Record<string, string>> = {
    "admin-a": "admin-a-secret-1",
    "ci-a": "ci-a-secret-value",
    "docs-reviewer-user": "docs-reviewer-secret",
    "reviewer-a-user": "reviewer-a-secret",
    "reviewer-b-user": "reviewer-b-secret",
    "source-ci": "source-ci-secret",
    "security-ci": "security-ci-secret",
    "scheduler-a": "scheduler-a-secret",
    "foreign-ci": "foreign-ci-secret",
    "promoter-a": "promoter-a-secret",
    "writer-a": "writer-a-secret-1"
  };
  const password = passwords[identity];
  if (password === undefined) throw new Error(`unknown fixture identity: ${identity}`);
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${identity}:${password}`).toString("base64")}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}
