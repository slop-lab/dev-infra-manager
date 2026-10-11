import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const evidenceScript = resolve(workspaceRoot, "verification/scripts/candidate-source-evidence.mjs");
const fixtureRoots: string[] = [];

function git(root: string, ...arguments_: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_MASTER: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
}

function successfulGit(root: string, ...arguments_: readonly string[]): string {
  const result = git(root, ...arguments_);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function createSingleRootCheckout(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-candidate-source-"));
  fixtureRoots.push(root);
  successfulGit(root, "init", "--initial-branch=main");
  await mkdir(resolve(root, ".dim"));
  await mkdir(resolve(root, ".gitea/workflows"), { recursive: true });
  await writeFile(resolve(root, ".dim/repos.yml"), "schemaVersion: 1\nrepositories:\n  root:\n    root: true\n");
  await writeFile(resolve(root, ".gitea/workflows/verify.yml"), "name: fixture\n");
  await writeFile(resolve(root, "source.txt"), "reviewed source\n");
  successfulGit(root, "add", "-A");
  successfulGit(
    root,
    "-c", "user.name=DIM Test",
    "-c", "user.email=test@dim.invalid",
    "commit", "-m", "candidate",
  );
  return root;
}

function runEvidence(root: string, expectedCommit: string, output: string): SpawnSyncReturns<string> {
  return spawnSync("node", [evidenceScript, expectedCommit, output], {
    cwd: root,
    encoding: "utf8",
  });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("candidate source evidence", () => {
  it("records the exact clean single-root HEAD and complete tree with private permissions", async () => {
    // Given
    const root = await createSingleRootCheckout();
    const commit = successfulGit(root, "rev-parse", "HEAD");
    const tree = successfulGit(root, "rev-parse", "HEAD^{tree}");
    const output = resolve(root, "..", `${root.split("/").at(-1)}-evidence.json`);

    // When
    const result = runEvidence(root, commit, output);

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      schemaVersion: 1,
      candidateCommit: commit,
      candidateTree: tree,
    });
    expect((await lstat(output, { bigint: true })).mode & 0o7777n).toBe(0o600n);
    expect(result.stdout).toBe(`candidate-commit=${commit} candidate-tree=${tree}\n`);
    await rm(output);
  });

  it("rejects a different commit without creating evidence", async () => {
    // Given
    const root = await createSingleRootCheckout();
    const output = resolve(root, "wrong-sha.json");

    // When
    const result = runEvidence(root, "0".repeat(40), output);

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checked-out candidate commit does not match expected commit");
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["unstaged", "staged"] as const)("rejects a %s tracked change without creating evidence", async (state) => {
    // Given
    const root = await createSingleRootCheckout();
    const commit = successfulGit(root, "rev-parse", "HEAD");
    const output = resolve(root, `${state}-dirty.json`);
    await writeFile(resolve(root, "source.txt"), "unreviewed change\n");
    if (state === "staged") successfulGit(root, "add", "source.txt");

    // When
    const result = runEvidence(root, commit, output);

    // Then
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate checkout has tracked changes");
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing, relative, and pre-existing artifact destinations", async () => {
    // Given
    const root = await createSingleRootCheckout();
    const commit = successfulGit(root, "rev-parse", "HEAD");
    const existing = resolve(root, "existing.json");
    await writeFile(existing, "preserve\n");

    // When
    const missing = spawnSync("node", [evidenceScript, commit], { cwd: root, encoding: "utf8" });
    const relative = runEvidence(root, commit, "relative.json");
    const occupied = runEvidence(root, commit, existing);

    // Then
    for (const result of [missing, relative]) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("complete lowercase candidate commit and absolute evidence path");
    }
    expect(occupied.status).not.toBe(0);
    expect(occupied.stderr).toContain("EEXIST");
    expect(await readFile(existing, "utf8")).toBe("preserve\n");
  });
});
