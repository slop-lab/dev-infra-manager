import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const builder = resolve(workspaceRoot, "project/scripts/build-monorepo-candidate.bash");
const rootContract = resolve(workspaceRoot, "project/.dim");
const repositories = [
  ["github-development", ""],
  ["development", ""],
  ["root", "."],
  ["core", "core"],
  ["core-development", "core-development"],
  ["plugin-dns-cloudflare", "plugin-dns-cloudflare"],
  ["plugin-dns-cloudflare-development", "plugin-dns-cloudflare-development"],
  ["plugin-external-urls", "plugin-external-urls"],
  ["plugin-external-urls-development", "plugin-external-urls-development"],
  ["verification", "verification"],
  ["examples", "examples"],
  ["specification", "specification"],
] as const;
const fixtureRoots: string[] = [];

export type FixtureRepository = {
  readonly name: (typeof repositories)[number][0];
  readonly destination: string;
  readonly path: string;
  readonly sha: string;
  readonly tree: string;
  readonly status: string;
  readonly remotes: string;
};

export function git(cwd: string, arguments_: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_MASTER: "1" },
  });
}

export function successfulGit(cwd: string, arguments_: readonly string[]): string {
  const result = git(cwd, arguments_);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function createRepository(root: string, name: FixtureRepository["name"]): Promise<FixtureRepository> {
  const path = resolve(root, name);
  await mkdir(path, { recursive: true });
  successfulGit(path, ["init", "--initial-branch=main"]);
  await writeFile(resolve(path, "content.txt"), `main-${name}\n`);
  if (name === "development") {
    await mkdir(resolve(path, ".gitea/workflows"), { recursive: true });
    await writeFile(resolve(path, ".gitea/workflows/verify.yml"), "fixture-workflow: preserve-exactly\n");
  }
  if (name === "root") {
    await cp(rootContract, resolve(path, ".dim"), { recursive: true });
    if ((await readFile(resolve(path, ".dim/qemu-service.mjs"), "utf8"))
      .includes('"/workspace/.dim/qemu-verify.bash"')) {
      successfulGit(path, ["apply", "--reverse", resolve(workspaceRoot, "scripts/monorepo-candidate-overlay/qemu-root-layout.patch")]);
    }
    await mkdir(resolve(path, "scripts"));
    for (const script of [
      "build-monorepo-candidate.bash",
      "build-workspace-image.bash", "install-source-build.bash", "local-package-version.bash",
      "local-preparation-state.bash", "pack-local-packages.mjs", "pack-source-build.bash",
      "prepare-source-build.bash", "monorepo-candidate-assembly.bash",
    ]) {
      await cp(resolve(workspaceRoot, "project/scripts", script), resolve(path, "scripts", script));
    }
    await cp(resolve(workspaceRoot, "project/scripts/monorepo-candidate-overlay"),
      resolve(path, "scripts/monorepo-candidate-overlay"), { recursive: true });
  }
  if (name === "verification") {
    await mkdir(resolve(path, "test"));
    await cp(resolve(workspaceRoot, "verification/scripts"), resolve(path, "scripts"), { recursive: true });
    for (const fixture of [
      "localControlPlaneInstall.test.ts", "localSourceBuildPolicy.test.ts",
      "qemuSetupOwnership.test.ts", "repositoryRefJourneyPolicy.test.ts",
    ]) {
      await cp(resolve(workspaceRoot, "verification/test", fixture), resolve(path, "test", fixture));
    }
    await cp(resolve(workspaceRoot, "verification/verify.just"), resolve(path, "verify.just"));
  }
  successfulGit(path, ["add", "-A"]);
  successfulGit(path, ["-c", "user.name=DIM Test", "-c", "user.email=test@dim.invalid", "commit", "-m", "main"]);
  successfulGit(path, ["switch", "-c", "candidate-tip"]);
  await writeFile(resolve(path, "content.txt"), `candidate-${name}\n`);
  successfulGit(path, ["add", "content.txt"]);
  successfulGit(path, ["-c", "user.name=DIM Test", "-c", "user.email=test@dim.invalid", "commit", "-m", "candidate"]);
  successfulGit(path, ["remote", "add", "origin", `https://invalid.example/${name}.git`]);

  const destination = repositories.find(([repository]) => repository === name)?.[1];
  expect(destination).toBeDefined();
  return {
    name,
    destination: destination ?? "",
    path,
    sha: successfulGit(path, ["rev-parse", "HEAD"]),
    tree: successfulGit(path, ["rev-parse", "HEAD^{tree}"]),
    status: successfulGit(path, ["status", "--porcelain=v1"]),
    remotes: successfulGit(path, ["remote", "-v"]),
  };
}

export async function createFixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  fixtureRoots.push(root);
  return root;
}

export async function createFixture(): Promise<readonly FixtureRepository[]> {
  const root = await createFixtureRoot("dim-monorepo-candidate-test-");
  return Promise.all(repositories.map(([name]) => createRepository(root, name)));
}

export function runBuilder(output: string, sources: readonly FixtureRepository[]): SpawnSyncReturns<string> {
  const arguments_ = [output];
  const githubDevelopment = sources.find(({ name }) => name === "github-development");
  if (githubDevelopment !== undefined) {
    arguments_.push("--github-development-source", githubDevelopment.path, githubDevelopment.sha);
  }
  for (const source of sources) {
    if (source.name === "github-development") continue;
    arguments_.push("--source", source.name, source.path, source.sha);
  }
  return spawnSync("/usr/bin/bash", [builder, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, GIT_MASTER: "1" },
  });
}

export async function nestedGitDirectories(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name === ".git")
    .map((entry) => resolve(entry.parentPath, entry.name));
}

export async function cleanupFixtureRoots(): Promise<void> {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
