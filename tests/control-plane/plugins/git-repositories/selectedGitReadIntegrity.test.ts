import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  readTreeFile
} from "../../../../packages/control-plane/plugins/git-repositories/src/git-read.js";
import { assertGitVersion } from "../../../../packages/control-plane/plugins/git-repositories/src/repository.js";
import { realGitVersion } from "./realGitIdentity.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("selected Git read object integrity", () => {
  it("rejects valid blob bytes stored under the wrong selected object ID", async () => {
    // Given
    const fixture = await repositoryFixture();
    const blob = (await run("/usr/bin/git", ["--git-dir", fixture.repository,
      "rev-parse", `${fixture.commit}:README.md`])).stdout.trim();
    const replacement = (await run("/bin/sh", ["-c",
      "printf 'replacement blob\\n' | /usr/bin/git --git-dir \"$1\" hash-object -t blob -w --stdin",
      "sh", fixture.repository])).stdout.trim();
    await replaceLooseObject(fixture.repository, blob, replacement, "blob");

    // When / Then
    await expect(readTreeFile(fixture.input, fixture.commit, "README.md"))
      .rejects.toThrow(/blob identity/i);
  });

  it.each(["root", "subtree"] as const)("rejects a valid replacement selected %s tree stored under its stale object ID", async (part) => {
    // Given a valid replacement tree pointing at another valid blob.
    const fixture = await repositoryFixture();
    const replacement = (await run("/bin/sh", ["-c",
      "printf 'replacement blob\\n' | /usr/bin/git --git-dir \"$1\" hash-object -t blob -w --stdin",
      "sh", fixture.repository])).stdout.trim();
    const replacementTree = (await run("/bin/sh", ["-c",
      "printf '100644 blob %s\\tREADME.md\\n' \"$1\" | /usr/bin/git --git-dir \"$2\" mktree",
      "sh", replacement, fixture.repository])).stdout.trim();
    const path = part === "root" ? "README.md" : "dir/README.md";
    expect((await readTreeFile(fixture.input, fixture.commit, path))?.blobId).not.toBe(replacement);
    await replaceLooseObject(fixture.repository, part === "root" ? fixture.tree : fixture.subtree, replacementTree, "tree");

    // When the unchanged commit/path is read after the valid-zlib substitution.
    const selected = readTreeFile(fixture.input, fixture.commit, path);
    // Then ancestor integrity fails instead of returning the replacement blob.
    await expect(selected).rejects.toThrow(part === "root" ? /tree identity|hash mismatch/i : /tree identity/i);
  });

  it("does not inspect an unrelated subtree when resolving a valid selected nested file", async () => {
    const fixture = await repositoryFixture();
    await replaceLooseObject(fixture.repository, fixture.unrelatedTree, fixture.subtree, "tree");
    const selected = await readTreeFile(fixture.input, fixture.commit, "dir/README.md");
    expect(selected).toMatchObject({ mode: "100644", byteLength: 14, lineCount: 1 });
    expect(await readTreeFile(fixture.input, fixture.commit, "dir/missing.txt")).toBeNull();
  });
});

async function repositoryFixture(): Promise<{
  readonly commit: string;
  readonly tree: string;
  readonly subtree: string;
  readonly unrelatedTree: string;
  readonly input: {
    readonly gitExecutable: string;
    readonly gitIdentity: Awaited<ReturnType<typeof assertGitVersion>>;
    readonly repository: string;
    readonly signal: AbortSignal;
  };
  readonly repository: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dim-selected-read-integrity-"));
  roots.push(root);
  const repository = join(root, "root.git");
  await run("/usr/bin/git", ["init", "--bare", "--initial-branch=main", repository]);
  const blob = (await run("/bin/sh", ["-c",
    "printf 'selected blob\\n' | /usr/bin/git --git-dir \"$1\" hash-object -t blob -w --stdin",
    "sh", repository])).stdout.trim();
  const subtree = (await run("/bin/sh", ["-c",
    "printf '100644 blob %s\\tREADME.md\\n' \"$1\" | /usr/bin/git --git-dir \"$2\" mktree",
    "sh", blob, repository])).stdout.trim();
  const unrelatedTree = (await run("/bin/sh", ["-c",
    "printf '100644 blob %s\\tunrelated.txt\\n' \"$1\" | /usr/bin/git --git-dir \"$2\" mktree",
    "sh", blob, repository])).stdout.trim();
  const tree = (await run("/bin/sh", ["-c",
    "printf '100644 blob %s\\tREADME.md\\n040000 tree %s\\tdir\\n040000 tree %s\\tother\\n' \"$1\" \"$2\" \"$3\" | /usr/bin/git --git-dir \"$4\" mktree",
    "sh", blob, subtree, unrelatedTree, repository])).stdout.trim();
  const commit = (await run("/usr/bin/git", ["--git-dir", repository,
    "-c", "user.name=DIM Test", "-c", "user.email=dim@example.invalid",
    "commit-tree", tree, "-m", "selected root"])).stdout.trim();
  await run("/usr/bin/git", ["--git-dir", repository, "update-ref", "refs/heads/main", commit]);
  return {
    commit,
    tree,
    subtree,
    unrelatedTree,
    input: {
      gitExecutable: "/usr/bin/git",
      gitIdentity: await assertGitVersion({ gitExecutable: "/usr/bin/git", gitVersion: realGitVersion }),
      repository,
      signal: AbortSignal.timeout(5_000)
    },
    repository
  };
}

async function replaceLooseObject(
  repository: string,
  selectedObjectId: string,
  replacementObjectId: string,
  type: "blob" | "tree"
): Promise<void> {
  const content = (await run("/usr/bin/git", ["--git-dir", repository, "cat-file", type, replacementObjectId], {
    encoding: "buffer"
  })).stdout;
  const directory = join(repository, "objects", selectedObjectId.slice(0, 2));
  await mkdir(directory, { recursive: true });
  const path = join(directory, selectedObjectId.slice(2));
  await chmod(path, 0o600);
  await writeFile(path, deflateSync(Buffer.concat([
    Buffer.from(`${type} ${String(content.length)}\0`), content
  ])));
  await chmod(path, 0o444);
}
