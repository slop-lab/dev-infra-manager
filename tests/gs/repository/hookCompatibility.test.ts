import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { assertRepositorySelector, initializeRepository } from "../../../packages/gs/repository/src/repository.js";

it("rejects non-string selector fields instead of coercing them into valid-looking identifiers", () => {
  expect(() => assertRepositorySelector({ namespaceId: undefined, repositoryId: "repo" })).toThrow();
  expect(() => assertRepositorySelector({ namespaceId: "group", repositoryId: null })).toThrow();
});

it("retains the exact persisted receive-hook ABI while moving authority ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "gs-receive-hook-"));
  try {
    const gitVersion = (await promisify(execFile)("/usr/bin/git", ["--version"])).stdout.trim().replace(/^git version /, "");
    const repository = await initializeRepository({ gitExecutable: "/usr/bin/git", gitVersion, storageRoot: root }, { namespaceId: "group", repositoryId: "repo" });
    expect(await readFile(join(repository, "hooks/pre-receive"))).toEqual(await readFile(new URL("./fixtures/pre-receive-v1.txt", import.meta.url)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects a malformed commit delivered in a received pack", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "gs-receive-fsck-"));
  const execute = promisify(execFile);
  const gitVersion = (await execute("/usr/bin/git", ["--version"])).stdout.trim().replace(/^git version /, "");
  const repository = await initializeRepository({ gitExecutable: "/usr/bin/git", gitVersion, storageRoot: root }, {
    namespaceId: "group",
    repositoryId: "repo",
  });
  const source = join(root, "source");
  const malformed = join(root, "malformed-commit");
  try {
    await execute("/usr/bin/git", ["init", "--initial-branch=main", source]);
    await execute("/usr/bin/git", ["-C", source, "config", "user.name", "GS Receive Test"]);
    await execute("/usr/bin/git", ["-C", source, "config", "user.email", "receive@example.invalid"]);
    await writeFile(join(source, "README.md"), "seed\n");
    await execute("/usr/bin/git", ["-C", source, "add", "README.md"]);
    await execute("/usr/bin/git", ["-C", source, "commit", "-m", "seed"]);
    const tree = (await execute("/usr/bin/git", ["-C", source, "rev-parse", "HEAD^{tree}"])).stdout.trim();
    await writeFile(malformed, `tree ${tree}\nauthor malformed\ncommitter malformed\n\nmalformed\n`);
    const objectId = (await execute("/usr/bin/git", ["-C", source, "hash-object", "--literally", "-t", "commit", "-w", malformed]))
      .stdout.trim();
    await execute("/usr/bin/git", ["-C", source, "update-ref", "refs/heads/malformed", objectId]);

    // When
    const push = execute("/usr/bin/git", ["-C", source, "push", repository, "refs/heads/malformed:refs/heads/malformed"]);

    // Then
    await expect(push).rejects.toMatchObject({
      stderr: expect.stringMatching(/fsck error|missingEmail/),
    });
    await expect(execute("/usr/bin/git", ["--git-dir", repository, "rev-parse", "--verify", "refs/heads/malformed"]))
      .rejects.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
