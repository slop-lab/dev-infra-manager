import { createTraversalRejectingGit, realGitVersion } from "./realGitIdentity.js";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { assertGitVersion } from "../../../../packages/control-plane/plugins/git-repositories/src/repository.js";
import {
  assertNativeRootObjectFormat,
  verifyNativeRootBundle
} from "../../../../packages/control-plane/plugins/git-repositories/src/native-root-import-git.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native root import Git object validation", () => {
  it("rejects an unselected malformed object in a received pack without whole-repository fsck", async () => {
    // Given
    const { root, repository } = await bareRepository();
    const blob = (await run("/bin/sh", ["-c",
      "printf 'valid root\\n' | /usr/bin/git --git-dir \"$1\" hash-object -t blob -w --stdin",
      "sh", repository])).stdout.trim();
    const tree = (await run("/bin/sh", ["-c",
      "printf '100644 blob %s\\tREADME.md\\n' \"$1\" | /usr/bin/git --git-dir \"$2\" mktree",
      "sh", blob, repository])).stdout.trim();
    const selectedCommit = (await run("/usr/bin/git", ["--git-dir", repository,
      "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
      "commit-tree", tree, "-m", "selected root"])).stdout.trim();
    const commitFile = join(root, "dangling-commit.txt");
    await writeFile(commitFile, "not a valid commit object\n");
    const { stdout } = await run("/usr/bin/git", ["--git-dir", repository,
      "hash-object", "--literally", "-t", "commit", "-w", commitFile]);
    const malformedCommit = stdout.trim();
    const packed = await run("/bin/sh", ["-c",
      "printf '%s\\n' \"$1\" \"$2\" \"$3\" \"$4\" | /usr/bin/git --git-dir \"$5\" pack-objects --stdout",
      "sh", selectedCommit, tree, blob, malformedCommit, repository], {
      encoding: "buffer"
    });
    const bundlePath = join(root, "malformed.bundle");
    await writeFile(bundlePath, Buffer.concat([
      Buffer.from(`# v2 git bundle\n${selectedCommit} refs/heads/main\n\n`),
      packed.stdout
    ]));
    const runtimeGit = await createTraversalRejectingGit(root);
    const wrapperIdentity = await assertGitVersion(runtimeGit);

    // When / Then
    await expect(verifyNativeRootBundle({
      gitExecutable: runtimeGit.gitExecutable,
      gitIdentity: wrapperIdentity,
      directory: root,
      canonicalRepository: repository,
      bundlePath,
      protectedRef: "refs/heads/main",
      expectedCommit: selectedCommit,
      signal: AbortSignal.timeout(5_000)
    })).rejects.toThrow(/bundle|object|tree|missing/i);
    await expect(access(runtimeGit.forbiddenInvocation)).rejects.toMatchObject({ code: "ENOENT" });
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
  const gitIdentity = await assertGitVersion({ gitExecutable: "/usr/bin/git", gitVersion: realGitVersion });
  return { root, repository, gitIdentity };
}
