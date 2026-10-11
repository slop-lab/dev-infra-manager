import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const cloneSourceHelper = resolve(workspaceRoot, "verification/scripts/lib/git-clone-source.bash");
const canonicalDirectories = ["core", "plugins", "tests", "verification", "examples", "specification"] as const;
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
  runGit(root, ["init", "--initial-branch=main"]);
  await writeFile(resolve(root, "marker.txt"), "committed-root\n");
  for (const directory of canonicalDirectories) {
    await mkdir(resolve(root, directory), { recursive: true });
    await writeFile(resolve(root, directory, "marker.txt"), `committed-${directory}\n`);
  }
  runGit(root, ["add", "."]);
  runGit(root, [
    "-c",
    "user.name=DIM Test",
    "-c",
    "user.email=test@dim.invalid",
    "commit",
    "-m",
    "canonical root fixture"
  ]);
  return root;
}

async function createProjectFixture(root: string): Promise<string> {
  const project = resolve(root, "project");
  await mkdir(project);
  runGit(project, ["init", "--initial-branch=main"]);
  await writeFile(resolve(project, "marker.txt"), "committed-project\n");
  runGit(project, ["add", "marker.txt"]);
  runGit(project, [
    "-c",
    "user.name=DIM Test",
    "-c",
    "user.email=test@dim.invalid",
    "commit",
    "-m",
    "project fixture"
  ]);
  return project;
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

describe("canonical workbench clone source", () => {
  it("snapshots one canonical DIM root with auto", async () => {
    // Given
    const root = await createFixture();

    // When
    const result = prepareWorkbenchSource(root, await createSnapshotDestination(), "auto");

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(resolve(result.stdout, "workbench/marker.txt"), "utf8")).toBe("committed-root\n");
    expect(await readFile(resolve(result.stdout, "workbench/specification/marker.txt"), "utf8")).toBe(
      "committed-specification\n"
    );
  });

  it("keeps an optional Project fixture separate from the canonical root", async () => {
    // Given
    const root = await createFixture();
    await createProjectFixture(root);

    // When
    const result = prepareWorkbenchSource(root, await createSnapshotDestination(), "auto");

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(resolve(result.stdout, "workbench/marker.txt"), "utf8")).toBe("committed-root\n");
    expect(await readFile(resolve(result.stdout, "workbench/project/marker.txt"), "utf8")).toBe(
      "committed-project\n"
    );
  });

  it("includes dirty root and Project fixture content with use", async () => {
    // Given
    const root = await createFixture();
    const project = await createProjectFixture(root);
    await writeFile(resolve(root, "marker.txt"), "dirty-root\n");
    await writeFile(resolve(root, "untracked.txt"), "untracked-root\n");
    await writeFile(resolve(project, "marker.txt"), "dirty-project\n");
    await writeFile(resolve(project, "untracked.txt"), "untracked-project\n");

    // When
    const result = prepareWorkbenchSource(root, await createSnapshotDestination(), "use");

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(resolve(result.stdout, "workbench/marker.txt"), "utf8")).toBe("dirty-root\n");
    expect(await readFile(resolve(result.stdout, "workbench/untracked.txt"), "utf8")).toBe("untracked-root\n");
    expect(await readFile(resolve(result.stdout, "workbench/project/marker.txt"), "utf8")).toBe("dirty-project\n");
    expect(await readFile(resolve(result.stdout, "workbench/project/untracked.txt"), "utf8")).toBe(
      "untracked-project\n"
    );
  });

  it("uses committed root and Project fixture content with discard", async () => {
    // Given
    const root = await createFixture();
    const project = await createProjectFixture(root);
    await writeFile(resolve(root, "marker.txt"), "dirty-root\n");
    await writeFile(resolve(project, "marker.txt"), "dirty-project\n");

    // When
    const result = prepareWorkbenchSource(root, await createSnapshotDestination(), "discard");

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(resolve(result.stdout, "workbench/marker.txt"), "utf8")).toBe("committed-root\n");
    expect(await readFile(resolve(result.stdout, "workbench/project/marker.txt"), "utf8")).toBe(
      "committed-project\n"
    );
  });

  it("rejects auto when the canonical root is dirty", async () => {
    // Given
    const root = await createFixture();
    await writeFile(resolve(root, "marker.txt"), "dirty-root\n");

    // When
    const result = prepareWorkbenchSource(root, await createSnapshotDestination(), "auto");

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("repository is dirty; pass --dirty-repo use or discard explicitly");
  });

  it("rejects auto when the optional Project fixture is dirty", async () => {
    // Given
    const root = await createFixture();
    const project = await createProjectFixture(root);
    await writeFile(resolve(project, "marker.txt"), "dirty-project\n");

    // When
    const result = prepareWorkbenchSource(root, await createSnapshotDestination(), "auto");

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("repository is dirty; pass --dirty-repo use or discard explicitly");
  });
});
