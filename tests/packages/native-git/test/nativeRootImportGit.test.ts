import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { assertGitVersion } from "../../../../core/packages/native-git/src/repository.js";
import {
  assertNativeRootCommitGraph,
  assertNativeRootObjectFormat
} from "../../../../core/packages/native-git/src/native-root-import-git.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native root import Git object validation", () => {
  it("rejects a commit whose referenced tree is missing without publishing a ref", async () => {
    const { root, repository, gitIdentity } = await bareRepository();
    const commitFile = join(root, "dangling-commit.txt");
    await writeFile(commitFile, `tree ${"1".repeat(40)}\n`
      + "author DIM <dim@example.invalid> 1700000000 +0000\n"
      + "committer DIM <dim@example.invalid> 1700000000 +0000\n\n"
      + "missing tree\n");
    const { stdout } = await run("/usr/bin/git", ["--git-dir", repository, "hash-object", "-t", "commit", "-w", commitFile]);
    const commit = stdout.trim();

    await expect(assertNativeRootCommitGraph({
      gitExecutable: "/usr/bin/git", gitIdentity, repository, commit,
      signal: AbortSignal.timeout(5_000)
    })).rejects.toThrow(/graph|fsck|missing/i);
    const refs = await run("/usr/bin/git", ["--git-dir", repository, "for-each-ref", "--format=%(refname)"]);
    expect(refs.stdout).toBe("");
  });

  it("rejects a SHA-256 object ID for a prepared SHA-1 repository", async () => {
    const { repository, gitIdentity } = await bareRepository();

    await expect(assertNativeRootObjectFormat({
      gitExecutable: "/usr/bin/git", gitIdentity, repository,
      expectedCommit: "c".repeat(64), signal: AbortSignal.timeout(5_000)
    })).rejects.toThrow(/object format/i);
  });
});

async function bareRepository() {
  const root = await mkdtemp(join(tmpdir(), "dim-native-root-git-validation-"));
  roots.push(root);
  const repository = join(root, "root.git");
  await run("/usr/bin/git", ["init", "--bare", "--object-format=sha1", repository]);
  const gitIdentity = await assertGitVersion({ gitExecutable: "/usr/bin/git", gitVersion: "2.43.0" });
  return { root, repository, gitIdentity };
}
