import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { repositoryPolicyRevision } from "../../../packages/gs/repository-contracts/src/index.js";
import { assertGitVersion, initializeRepository } from "../../../packages/gs/repository/src/index.js";
import {
  createGitRepositoryReadService,
  type RepositoryAccess,
  type RepositoryReadService,
} from "../../../packages/gs/repository-service/src/index.js";
import { inspectAuthoritativeReviewGit, readAuthoritativeCandidateFile } from "../../../packages/gs/review/src/index.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("inspects an ordinarily pushed review after reopening the reader without scanning unrelated corruption", async () => {
  // Given
  const fixture = await reviewFixture("push");
  const readerBeforeRestart = fixture.openReader();
  expect(await readerBeforeRestart.readRef(fixture.access, fixture.proposalRef)).toBe(fixture.candidateCommit);
  const unrelatedPath = join(fixture.worktree, "unrelated-object");
  await writeFile(unrelatedPath, "unrelated object\n");
  const unrelatedObject = await git(fixture.gitDirectory, ["hash-object", "-w", unrelatedPath]);
  await corruptLooseObject(fixture.gitDirectory, unrelatedObject);
  const commands: string[][] = [];
  const reader = recordingReader(fixture.openReader(), commands);

  // When
  const evidence = await inspectAuthoritativeReviewGit({
    reader,
    access: fixture.access,
    protectedRef: "refs/heads/main",
    expectedProtectedHead: fixture.baseCommit,
    proposalRef: fixture.proposalRef,
    signal: AbortSignal.timeout(30_000),
  });

  // Then
  expect(evidence).toMatchObject({
    expectedProtectedHead: fixture.baseCommit,
    candidateCommit: fixture.candidateCommit,
    candidateTree: fixture.candidateTree,
  });
  expect(commands.some((arguments_) => arguments_.includes("fsck"))).toBe(false);
});

it.each(["commit", "tree", "subtree", "blob"] as const)("rejects a selected %s whose valid payload does not match its object ID", async (kind) => {
  // Given
  const fixture = await reviewFixture();
  const objectId = kind === "commit" ? fixture.candidateCommit
    : kind === "tree" ? fixture.candidateTree
      : kind === "subtree" ? fixture.candidateSubtree
      : fixture.candidateBlob;
  const content = kind === "commit"
    ? Buffer.concat([await gitBytes(fixture.worktree, ["cat-file", "commit", objectId]), Buffer.from("\naltered\n")])
    : kind === "tree"
      ? await gitBytes(fixture.worktree, ["cat-file", "tree", fixture.baseTree])
      : kind === "subtree"
        ? await gitBytes(fixture.worktree, ["cat-file", "tree", fixture.baseSubtree])
      : Buffer.from("altered candidate\n");
  await replaceLooseObject(fixture.gitDirectory, objectId, kind === "subtree" ? "tree" : kind, content);

  // When
  const inspection = inspectAuthoritativeReviewGit({
    reader: fixture.openReader(),
    access: fixture.access,
    protectedRef: "refs/heads/main",
    expectedProtectedHead: fixture.baseCommit,
    proposalRef: fixture.proposalRef,
    signal: AbortSignal.timeout(30_000),
  });

  // Then
  await expect(inspection).rejects.toBeDefined();
});

it("rejects a matcher path traversing a valid altered subtree under its stale object ID", async () => {
  // Given
  const fixture = await reviewFixture();
  const content = await gitBytes(fixture.worktree, ["cat-file", "tree", fixture.baseSubtree]);
  await replaceLooseObject(fixture.gitDirectory, fixture.candidateSubtree, "tree", content);

  // When
  const read = readAuthoritativeCandidateFile({
    reader: fixture.openReader(),
    access: fixture.access,
    candidateCommit: fixture.candidateCommit,
    path: "src/README.md",
    signal: AbortSignal.timeout(30_000),
  });

  // Then
  await expect(read).rejects.toBeDefined();
});

it.each(["added", "deleted"] as const)("preserves optional file absence across an %s directory", async (directory) => {
  const fixture = await reviewFixture("direct", true);
  const read = (candidateCommit: string) => readAuthoritativeCandidateFile({
    reader: fixture.openReader(), access: fixture.access, candidateCommit,
    path: `${directory}/optional.md`, signal: AbortSignal.timeout(30_000),
  });
  const present = directory === "added" ? fixture.candidateCommit : fixture.baseCommit;
  const missing = directory === "added" ? fixture.baseCommit : fixture.candidateCommit;
  await expect(read(present)).resolves.toEqual(Buffer.from("optional\n"));
  await expect(read(missing)).resolves.toBeUndefined();
});

it("treats a non-tree intermediate as ordinary optional-file absence", async () => {
  const fixture = await reviewFixture();
  await expect(readAuthoritativeCandidateFile({
    reader: fixture.openReader(), access: fixture.access, candidateCommit: fixture.candidateCommit,
    path: "src/README.md/optional.md", signal: AbortSignal.timeout(30_000),
  })).resolves.toBeUndefined();
});

function recordingReader(reader: RepositoryReadService, commands: string[][]): RepositoryReadService {
  return {
    ...reader,
    async readBytes(input) {
      commands.push([...input.args]);
      return reader.readBytes(input);
    },
  };
}

async function reviewFixture(transport: "direct" | "push" = "direct", optionalDirectories = false): Promise<{
  readonly worktree: string;
  readonly gitDirectory: string;
  readonly openReader: () => RepositoryReadService;
  readonly access: RepositoryAccess;
  readonly baseCommit: string;
  readonly baseTree: string;
  readonly baseSubtree: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly candidateSubtree: string;
  readonly candidateBlob: string;
  readonly proposalRef: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "gs-review-integrity-"));
  roots.push(root);
  const worktree = join(root, "repository");
  await mkdir(worktree);
  await git(worktree, ["init", "--initial-branch=main"]);
  await git(worktree, ["config", "user.name", "GS Review Integrity"]);
  await git(worktree, ["config", "user.email", "review-integrity@example.invalid"]);
  await mkdir(join(worktree, "src"));
  await writeFile(join(worktree, "src/README.md"), "base\n");
  await git(worktree, ["add", "src/README.md"]);
  if (optionalDirectories) {
    await mkdir(join(worktree, "deleted"));
    await writeFile(join(worktree, "deleted/optional.md"), "optional\n");
    await git(worktree, ["add", "deleted/optional.md"]);
  }
  await git(worktree, ["commit", "-m", "base"]);
  const baseCommit = await git(worktree, ["rev-parse", "HEAD"]);
  const baseTree = await git(worktree, ["rev-parse", "HEAD^{tree}"]);
  const baseSubtree = await git(worktree, ["rev-parse", "HEAD:src"]);
  await writeFile(join(worktree, "src/README.md"), "candidate\n");
  if (optionalDirectories) {
    await rm(join(worktree, "deleted"), { recursive: true });
    await mkdir(join(worktree, "added"));
    await writeFile(join(worktree, "added/optional.md"), "optional\n");
    await git(worktree, ["add", "--all"]);
  }
  await git(worktree, ["commit", "-am", "candidate"]);
  const candidateCommit = await git(worktree, ["rev-parse", "HEAD"]);
  const candidateTree = await git(worktree, ["rev-parse", "HEAD^{tree}"]);
  const candidateSubtree = await git(worktree, ["rev-parse", "HEAD:src"]);
  const candidateBlob = await git(worktree, ["rev-parse", "HEAD:src/README.md"]);
  const proposalRef = "refs/heads/proposals/reviewer/change";
  const gitVersion = (await git(worktree, ["--version"])).replace(/^git version /, "");
  const runtime = { gitExecutable: "/usr/bin/git" };
  const gitIdentity = await assertGitVersion({ ...runtime, gitVersion });
  let gitDirectory: string;
  if (transport === "push") {
    const storageRoot = join(root, "storage");
    gitDirectory = await initializeRepository({ ...runtime, gitVersion, storageRoot }, {
      namespaceId: "tenant",
      repositoryId: "repository",
    });
    await git(worktree, ["push", gitDirectory, `${candidateCommit}:${proposalRef}`], {
      DIM_NATIVE_GIT_PROTECTED_REFS: "refs/heads/main",
      DIM_NATIVE_GIT_WORKSPACE_ID: "reviewer",
    });
    await git(gitDirectory, ["update-ref", "refs/heads/main", baseCommit]);
  } else {
    await git(worktree, ["update-ref", proposalRef, candidateCommit]);
    await git(worktree, ["update-ref", "refs/heads/main", baseCommit]);
    gitDirectory = join(worktree, ".git");
  }
  const openReader = () => createGitRepositoryReadService({ runtime, gitIdentity });
  const policyBase = { schemaVersion: 1 as const, protectedRef: "refs/heads/main", extensions: {} };
  const policy = { ...policyBase, policyRevision: repositoryPolicyRevision(policyBase) };
  const access: RepositoryAccess = {
    principalId: "reviewer",
    target: {
      selector: { namespaceId: "tenant", repositoryId: "repository" },
      repositoryPath: gitDirectory,
      head: { sequence: 0, protectedRef: "refs/heads/main", commit: baseCommit, tree: baseTree },
      incarnationId: "incarnation",
      authorityEpoch: "epoch",
      policyDigest: policy.policyRevision,
      ownerPrincipalId: "owner",
      refPolicyRevision: policy.policyRevision,
      policy,
    },
  };
  return { worktree, gitDirectory, openReader, access, baseCommit, baseTree, baseSubtree,
    candidateCommit, candidateTree, candidateSubtree, candidateBlob, proposalRef };
}

async function git(
  repository: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<string> {
  const result = await execute("/usr/bin/git", ["--no-replace-objects", "-C", repository, ...arguments_], {
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      HOME: "/dev/null",
      LC_ALL: "C",
      ...environment,
    },
  });
  return result.stdout.trim();
}

async function gitBytes(repository: string, arguments_: readonly string[]): Promise<Buffer> {
  const result = await execute("/usr/bin/git", ["--no-replace-objects", "-C", repository, ...arguments_], {
    encoding: "buffer",
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      HOME: "/dev/null",
      LC_ALL: "C",
    },
  });
  return result.stdout;
}

async function corruptLooseObject(gitDirectory: string, objectId: string): Promise<void> {
  const objectPath = join(gitDirectory, "objects", objectId.slice(0, 2), objectId.slice(2));
  await chmod(objectPath, 0o600);
  await writeFile(objectPath, "corrupt object\n");
}

async function replaceLooseObject(
  gitDirectory: string,
  objectId: string,
  type: "commit" | "tree" | "blob",
  content: Buffer,
): Promise<void> {
  const objectPath = join(gitDirectory, "objects", objectId.slice(0, 2), objectId.slice(2));
  await chmod(objectPath, 0o600);
  await writeFile(objectPath, deflateSync(Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content])));
}
