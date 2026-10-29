import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { repositoryPolicyRevision } from "../../../packages/gs/repository-contracts/src/index.js";
import { assertGitVersion, initializeRepository } from "../../../packages/gs/repository/src/index.js";
import type { RefUpdatePolicy } from "../../../packages/gs/repository-service/src/index.js";

const execute = promisify(execFile);
const roots: string[] = [];

export async function cleanupAuthorityFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export function allowAllRefUpdatePolicies(revision = "f".repeat(64)): readonly RefUpdatePolicy[] {
  return [{ name: "allow-all", revision, async authorize() {} }];
}

export async function addAuthorityRepository(
  fixture: Awaited<ReturnType<typeof authorityFixture>>,
  repositoryId: string,
): Promise<{ readonly namespaceId: "tenant"; readonly repositoryId: string }> {
  const selector = { namespaceId: "tenant" as const, repositoryId };
  const repository = await initializeRepository(fixture.runtime, selector);
  await git("/usr/bin/git", ["--git-dir", repository, "fetch", fixture.repository,
    "refs/heads/main:refs/heads/main", "refs/heads/proposals/change:refs/heads/proposals/change"]);
  return selector;
}

export async function authorityFixture(options: { readonly wrappedGit?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gs-repository-authority-"));
  roots.push(root);
  const storageRoot = join(root, "storage");
  const repository = join(storageRoot, "tenant", "main.git");
  const source = join(root, "source");
  await mkdir(join(storageRoot, "tenant"), { recursive: true });
  const systemGitVersion = (await git("/usr/bin/git", ["--version"])).replace(/^git version /, "");
  await initializeRepository({ gitExecutable: "/usr/bin/git", gitVersion: systemGitVersion, storageRoot }, {
    namespaceId: "tenant",
    repositoryId: "main",
  });
  await git("/usr/bin/git", ["init", source]);
  await git("/usr/bin/git", ["-C", source, "config", "user.name", "Test"]);
  await git("/usr/bin/git", ["-C", source, "config", "user.email", "test@example.invalid"]);
  await writeFile(join(source, "README.md"), "initial\n");
  await git("/usr/bin/git", ["-C", source, "add", "README.md"]);
  await git("/usr/bin/git", ["-C", source, "commit", "-m", "initial"]);
  const initialCommit = await revParse(source, "HEAD");
  const initialTree = await revParse(source, "HEAD^{tree}");
  await git("/usr/bin/git", ["--git-dir", repository, "fetch", source, "HEAD:refs/heads/main"]);
  await writeFile(join(source, "README.md"), "candidate\n");
  await git("/usr/bin/git", ["-C", source, "commit", "-am", "candidate"]);
  const candidateCommit = await revParse(source, "HEAD");
  const candidateTree = await revParse(source, "HEAD^{tree}");
  const proposalRef = "refs/heads/proposals/change";
  await git("/usr/bin/git", ["--git-dir", repository, "fetch", source, `HEAD:${proposalRef}`]);
  const modePath = join(root, "git-mode");
  await writeFile(modePath, "pass\n");
  const gitExecutable = options.wrappedGit === true
    ? await createGitWrapper(root, modePath)
    : "/usr/bin/git";
  const gitVersion = (await git(gitExecutable, ["--version"])).replace(/^git version /, "");
  const policyBase = { schemaVersion: 1 as const, protectedRef: "refs/heads/main", extensions: {} };
  const policy = { ...policyBase, policyRevision: repositoryPolicyRevision(policyBase) };
  return {
    root,
    statePath: join(root, "authority.sqlite3"),
    runtime: { gitExecutable, gitVersion, storageRoot },
    gitIdentity: await assertGitVersion({ gitExecutable, gitVersion }),
    selector: { namespaceId: "tenant", repositoryId: "main" } as const,
    repository,
    policy,
    initial: { commit: initialCommit, tree: initialTree },
    change: {
      namespaceId: "tenant",
      repositoryId: "main",
      proposalRef,
      expectedCommit: initialCommit,
      candidateCommit,
      candidateTree,
      authorizationId: "a".repeat(64),
      evidenceDigest: "b".repeat(64),
    },
    setGitMode: (mode: "pass" | "before" | "after") => writeFile(modePath, `${mode}\n`),
  };
}

export async function ref(repository: string, name: string): Promise<string> {
  return git("/usr/bin/git", ["--git-dir", repository, "rev-parse", "--verify", name]);
}

async function createGitWrapper(root: string, modePath: string): Promise<string> {
  const wrapper = join(root, "git-wrapper");
  await writeFile(wrapper, `#!/bin/sh\nset -eu\nmode=$(cat ${JSON.stringify(modePath)})\ncase "$*:$mode" in\n  *update-ref*stdin*:before) exit 23 ;;\n  *update-ref*stdin*:after) /usr/bin/git "$@"; exit 23 ;;\n  *) exec /usr/bin/git "$@" ;;\nesac\n`);
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function revParse(repository: string, expression: string): Promise<string> {
  return git("/usr/bin/git", ["-C", repository, "rev-parse", expression]);
}

async function git(executable: string, args: readonly string[]): Promise<string> {
  return (await execute(executable, args, { env: { ...process.env, LC_ALL: "C" } })).stdout.trim();
}
