import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
