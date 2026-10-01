import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const cloneSourceHelper = resolve(workspaceRoot, "verification/scripts/lib/git-clone-source.bash");
const repositoryDirectories = [
  ["development", ""],
  ["root", "project"],
  ["core", "core"],
  ["core-development", "core-development"],
  ["plugin-dns-cloudflare", "plugin-dns-cloudflare"],
  ["plugin-dns-cloudflare-development", "plugin-dns-cloudflare-development"],
  ["plugin-external-urls", "plugin-external-urls"],
  ["plugin-external-urls-development", "plugin-external-urls-development"],
  ["verification", "verification"],
  ["examples", "examples"],
  ["specification", "specification"]
] as const;
const fixtureRoots: string[] = [];

function runGit(cwd: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_MASTER: "1" }
  });
  expect(result.status, result.stderr).toBe(0);
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-workbench-source-"));
  fixtureRoots.push(root);

  for (const [repository, directory] of repositoryDirectories) {
    const repositoryRoot = resolve(root, directory);
    await mkdir(repositoryRoot, { recursive: true });
    runGit(repositoryRoot, ["init", "--initial-branch=main"]);
    await writeFile(resolve(repositoryRoot, "marker.txt"), `committed-${repository}\n`);
    runGit(repositoryRoot, ["add", "marker.txt"]);
    runGit(repositoryRoot, [
      "-c",
      "user.name=DIM Test",
      "-c",
      "user.email=test@dim.invalid",
      "commit",
      "-m",
      "fixture"
    ]);
  }

  await writeFile(
    resolve(root, ".git/info/exclude"),
    `${repositoryDirectories
      .map(([, directory]) => directory)
      .filter((directory) => directory.length > 0)
      .map((directory) => `${directory}/`)
      .join("\n")}\n`
  );
  return root;
}

function prepareWorkbenchSource(root: string, snapshot: string, policy: "auto" | "discard" | "use") {
  return spawnSync(
    "/usr/bin/bash",
    [
      "-c",
      'set -euo pipefail; source "$1"; dim_prepare_workbench_clone_source "$2" "$3" "$4"; printf "%s" "$DIM_GIT_CLONE_SOURCE"',
      "bash",
      cloneSourceHelper,
      root,
      snapshot,
      policy
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GIT_MASTER: "1" }
    }
  );
}

async function createSnapshotDestination(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-workbench-snapshot-"));
  fixtureRoots.push(root);
  return resolve(root, "source");
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("assembled workbench clone source", () => {
  it("accepts a clean split repository set with auto", async () => {
    // Given
    const root = await createFixture();

    // When
    const result = prepareWorkbenchSource(root, await createSnapshotDestination(), "auto");

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(resolve(result.stdout, "workbench/project/marker.txt"), "utf8")).toBe("committed-root\n");
    expect(await readFile(resolve(result.stdout, "workbench/specification/marker.txt"), "utf8")).toBe(
      "committed-specification\n"
    );
  });

  it("includes each repository's tracked and non-ignored untracked content with use", async () => {
    // Given
    const root = await createFixture();
    for (const [repository, directory] of repositoryDirectories) {
      const repositoryRoot = resolve(root, directory);
      await writeFile(resolve(repositoryRoot, "marker.txt"), `dirty-${repository}\n`);
      await writeFile(resolve(repositoryRoot, "untracked.txt"), `untracked-${repository}\n`);
    }

    // When
    const result = prepareWorkbenchSource(root, await createSnapshotDestination(), "use");

    // Then
    expect(result.status, result.stderr).toBe(0);
    for (const [repository, directory] of repositoryDirectories) {
      const snapshotRepository = resolve(result.stdout, "workbench", directory);
      expect(await readFile(resolve(snapshotRepository, "marker.txt"), "utf8")).toBe(`dirty-${repository}\n`);
      expect(await readFile(resolve(snapshotRepository, "untracked.txt"), "utf8")).toBe(`untracked-${repository}\n`);
    }
  });

  it("uses every repository's committed content with discard", async () => {
    // Given
    const root = await createFixture();
    await writeFile(resolve(root, "verification/marker.txt"), "dirty-verification\n");
    await writeFile(resolve(root, "verification/untracked.txt"), "untracked-verification\n");

    // When
    const result = prepareWorkbenchSource(root, await createSnapshotDestination(), "discard");

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(resolve(result.stdout, "workbench/verification/marker.txt"), "utf8")).toBe(
      "committed-verification\n"
    );
    await expect(readFile(resolve(result.stdout, "workbench/verification/untracked.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects auto when a split repository is dirty", async () => {
    // Given
    const root = await createFixture();
    await writeFile(resolve(root, "examples/marker.txt"), "dirty-examples\n");

    // When
    const result = prepareWorkbenchSource(root, await createSnapshotDestination(), "auto");

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("repository is dirty; pass --dirty-repo use or discard explicitly");
  });
});
