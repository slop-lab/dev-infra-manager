import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  cleanupFixtureRoots,
  createFixture,
  createFixtureRoot,
  git,
  nestedGitDirectories,
  runBuilder,
  successfulGit,
} from "./monorepoCandidateFixture.js";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const overlayRoot = resolve(workspaceRoot, "project/scripts/monorepo-candidate-overlay");
const overlayInputs = [
  ["CODEOWNERS", ".gitea/CODEOWNERS"],
  ["repos.yml", ".dim/repos.yml"],
  ["workspace-repositories.json", ".dim/workspace-repositories.json"],
  ["reconcile-repositories.sh", ".dim/reconcile-repositories.sh"],
  ["qemu-root-layout.patch", "git-apply"],
  ["repository-materialization-smoke.bash", "verification/scripts/repository-materialization-smoke.bash"],
] as const;

afterEach(async () => {
  await cleanupFixtureRoots();
});

describe("monorepo candidate builder", () => {
  it("assembles exact feature tips with preserved ancestry and trees", async () => {
    // Given
    const sources = await createFixture();
    expect(sources).toHaveLength(12);
    const githubDevelopment = sources.find(({ name }) => name === "github-development");
    const development = sources.find(({ name }) => name === "development");
    expect(githubDevelopment).toBeDefined();
    expect(development).toBeDefined();
    expect(git(development?.path ?? "", ["merge-base", githubDevelopment?.sha ?? "", development?.sha ?? ""]).status)
      .not.toBe(0);
    const verification = sources.find(({ name }) => name === "verification");
    expect(successfulGit(verification?.path ?? "", ["ls-tree", "-r", "--name-only", "HEAD"]))
      .toContain("test/localSourceBuildPolicy.test.ts");
    const outputRoot = await createFixtureRoot("dim-monorepo-candidate-output-");
    const output = resolve(outputRoot, "candidate");

    // When
    const result = runBuilder(output, sources);

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(successfulGit(output, ["remote"])).toBe("");
    for (const source of sources) {
      expect(git(output, ["merge-base", "--is-ancestor", source.sha, "HEAD"]).status).toBe(0);
      expect(git(output, ["cat-file", "-e", `${source.tree}^{tree}`]).status).toBe(0);
      if (source.destination.length > 0 && source.name !== "root" && source.name !== "verification") {
        expect(successfulGit(output, ["rev-parse", `HEAD:${source.destination}`])).toBe(source.tree);
      }
      expect(successfulGit(source.path, ["status", "--porcelain=v1"])).toBe(source.status);
      expect(successfulGit(source.path, ["remote", "-v"])).toBe(source.remotes);
    }
    const githubParentLine = successfulGit(output, ["rev-list", "--parents", "HEAD"])
      .split("\n")
      .map((line) => line.split(" "))
      .find(([, ...parents]) => parents.includes(githubDevelopment?.sha ?? ""));
    expect(githubParentLine?.slice(1)).toEqual([development?.sha, githubDevelopment?.sha]);
    expect(successfulGit(output, ["rev-parse", `${githubParentLine?.[0] ?? "missing"}^{tree}`])).toBe(development?.tree);
    expect(await readFile(resolve(output, "content.txt"), "utf8")).toBe("candidate-development\n");
    expect(await readFile(resolve(output, "core/content.txt"), "utf8")).toBe("candidate-core\n");
    const evidence = await readFile(resolve(output, ".monorepo-candidate/sources.tsv"), "utf8");
    for (const source of sources) {
      if (source.name === "github-development") continue;
      expect(evidence).toContain(`${source.name}\t${source.destination || "."}\t${source.sha}\t${source.tree}\t`);
    }
    expect(evidence.trim().split("\n")).toHaveLength(12);
    expect(await readFile(resolve(output, ".monorepo-candidate/github-development.tsv"), "utf8"))
      .toBe(`repository\tsource_commit\tsource_tree\tancestry_policy\n` +
        `github-development\t${githubDevelopment?.sha}\t${githubDevelopment?.tree}\thistory-only-merge-parent\n`);
  });

  it("materializes one operational Project repository", async () => {
    // Given
    const sources = await createFixture();
    const outputRoot = await createFixtureRoot("dim-monorepo-operational-output-");
    const output = resolve(outputRoot, "candidate");
    const remoteBase = resolve(outputRoot, "remotes");
    const workspaceData = resolve(outputRoot, "data");
    await mkdir(remoteBase);

    // When
    const result = runBuilder(output, sources);

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(resolve(output, ".dim/qemu-service.mjs"), "utf8"))
      .toContain('"/workspace/.dim/qemu-verify.bash"');
    expect(await readFile(resolve(output, ".dim/qemu-verify.bash"), "utf8"))
      .toContain('test -d "$repo_root/.dim"');
    expect(await readFile(resolve(output, "verification/scripts/repository-materialization-smoke.bash"), "utf8"))
      .toContain('root_repository="${DIM_ROOT_REPOSITORY:-$workspace_root}"');
    const materializationSmoke = spawnSync("bash", [resolve(output, "verification/scripts/repository-materialization-smoke.bash")], {
      encoding: "utf8", env: { ...process.env, GIT_MASTER: "1" }
    });
    expect(materializationSmoke.status, materializationSmoke.stderr).toBe(0);
    expect(materializationSmoke.stdout).toContain("repository-materialization-smoke-ok");
    const codeowners = await readFile(resolve(output, ".gitea/CODEOWNERS"), "utf8");
    for (const trustedInput of [
      ".dim/setup.sh", ".dim/ci/runner.yml", ".gitea/workflows/verify.yml",
      "scripts/workspace-user-setup.bash", "scripts/monorepo-candidate-assembly.bash",
      "agent/Dockerfile", "images/project-workspace/Dockerfile",
      "core/packages/core/src/project-registry/repositoryProtection.ts",
      "verification/scripts/container-self-project-smoke.bash", "justfile", "pnpm-lock.yaml",
      ".monorepo-candidate/sources.tsv"
    ]) {
      expect(codeowners.split("\n").some((line) => {
        const rule = line.split(" ")[0];
        return rule !== undefined && rule !== "" && !rule.startsWith("#") && new RegExp(rule).test(trustedInput);
      }), trustedInput).toBe(true);
    }
    const development = sources.find(({ name }) => name === "development");
    expect(development).toBeDefined();
    expect(await readFile(resolve(output, ".gitea/workflows/verify.yml"), "utf8"))
      .toBe(await readFile(resolve(development?.path ?? "", ".gitea/workflows/verify.yml"), "utf8"));

    const overlayEvidence = resolve(output, ".monorepo-candidate");
    const overlayManifest = await readFile(resolve(overlayEvidence, "overlay.tsv"), "utf8");
    for (const [input, target] of overlayInputs) {
      const bytes = await readFile(resolve(overlayEvidence, "overlay", input));
      expect(bytes).toEqual(await readFile(resolve(overlayRoot, input)));
      expect(overlayManifest).toContain(`${input}\t${target}\t${createHash("sha256").update(bytes).digest("hex")}\n`);
    }
    expect(await readFile(resolve(overlayEvidence, "overlay.digest"), "utf8"))
      .toBe(`${createHash("sha256").update(overlayManifest).digest("hex")}\n`);
    expect(await nestedGitDirectories(output)).toEqual([resolve(output, ".git")]);
    expect(git(output, ["cat-file", "-e", "HEAD:project"]).status).not.toBe(0);

    const catalog = parse(await readFile(resolve(output, ".dim/repos.yml"), "utf8"));
    expect(Object.keys(catalog.repositories)).toEqual(["root"]);
    expect(catalog.upstreams.root.url).toBe("https://github.com/slop-lab/dev-infra-manager.git");
    expect(catalog.repositories.root.root).toBe(true);

    successfulGit(outputRoot, ["clone", "--bare", output, resolve(remoteBase, "root.git")]);
    successfulGit(outputRoot, ["--git-dir", resolve(remoteBase, "root.git"), "branch", "main", successfulGit(output, ["rev-parse", "HEAD"])]);
    await mkdir(workspaceData);
    const manifest = resolve(outputRoot, "manifest.json");
    await writeFile(manifest, JSON.stringify({ gitBaseUrl: remoteBase }));
    const materialization = spawnSync("/usr/bin/sh", [resolve(output, ".dim/reconcile-repositories.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        DIM_PROJECT_MANIFEST: manifest,
        DIM_PROJECT_ROOT: output,
        DIM_WORKSPACE_DATA: workspaceData,
        GIT_MASTER: "1",
      },
    });
    expect(materialization.status, materialization.stderr).toBe(0);
    const materialized = resolve(workspaceData, "workspace");
    expect(await readFile(resolve(materialized, "core/content.txt"), "utf8")).toBe("candidate-core\n");
    expect(await nestedGitDirectories(materialized)).toEqual([resolve(materialized, ".git")]);
    expect(await readFile(resolve(materialized, ".git/info/exclude"), "utf8")).not.toContain("core/");
  });

  it("rejects a development-owned Project contract without creating output", async () => {
    // Given
    const sources = await createFixture();
    const development = sources.find(({ name }) => name === "development");
    expect(development).toBeDefined();
    await mkdir(resolve(development?.path ?? "", ".dim"));
    await writeFile(resolve(development?.path ?? "", ".dim/owned.txt"), "collision\n");
    successfulGit(development?.path ?? "", ["add", ".dim/owned.txt"]);
    successfulGit(development?.path ?? "", ["-c", "user.name=DIM Test", "-c", "user.email=test@dim.invalid", "commit", "-m", "collision"]);
    const selectedSources = sources.map((source) => source.name === "development"
      ? { ...source, sha: successfulGit(source.path, ["rev-parse", "HEAD"]) }
      : source);
    const outputRoot = await createFixtureRoot("dim-monorepo-contract-collision-output-");
    const output = resolve(outputRoot, "candidate");

    // When
    const result = runBuilder(output, selectedSources);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("development tree already owns Project contract destination: .dim");
    expect(git(outputRoot, ["-C", output, "status"]).status).not.toBe(0);
  });

  it("rejects a root-development destination collision without creating output", async () => {
    // Given
    const sources = await createFixture();
    const development = sources.find(({ name }) => name === "development");
    expect(development).toBeDefined();
    await mkdir(resolve(development?.path ?? "", "core"));
    await writeFile(resolve(development?.path ?? "", "core/owned.txt"), "development owns this path\n");
    successfulGit(development?.path ?? "", ["add", "core/owned.txt"]);
    successfulGit(development?.path ?? "", ["-c", "user.name=DIM Test", "-c", "user.email=test@dim.invalid", "commit", "-m", "collision"]);
    const selectedSources = sources.map((source) => source.name === "development"
      ? { ...source, sha: successfulGit(source.path, ["rev-parse", "HEAD"]) }
      : source);
    const outputRoot = await createFixtureRoot("dim-monorepo-collision-output-");
    const output = resolve(outputRoot, "candidate");

    // When
    const result = runBuilder(output, selectedSources);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("development tree already owns import destination: core");
    expect(git(outputRoot, ["-C", output, "status"]).status).not.toBe(0);
  });

  it("rejects an abbreviated GitHub development ref before creating output", async () => {
    // Given
    const sources = await createFixture();
    const invalidSources = sources.map((source) => source.name === "github-development"
      ? { ...source, sha: "candidate-tip" }
      : source);
    const outputRoot = await createFixtureRoot("dim-monorepo-ref-output-");
    const output = resolve(outputRoot, "candidate");

    // When
    const result = runBuilder(output, invalidSources);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("GitHub development commit must be exactly 40 lowercase hexadecimal characters");
    expect(git(outputRoot, ["-C", output, "status"]).status).not.toBe(0);
  });

  it("rejects a missing GitHub development source before creating output", async () => {
    // Given
    const sources = (await createFixture()).filter(({ name }) => name !== "github-development");
    const outputRoot = await createFixtureRoot("dim-monorepo-missing-github-output-");
    const output = resolve(outputRoot, "candidate");

    // When
    const result = runBuilder(output, sources);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing GitHub development source");
    expect(git(outputRoot, ["-C", output, "status"]).status).not.toBe(0);
  });

  it("rejects an unavailable GitHub development commit before creating output", async () => {
    // Given
    const sources = (await createFixture()).map((source) => source.name === "github-development"
      ? { ...source, sha: "ffffffffffffffffffffffffffffffffffffffff" }
      : source);
    const outputRoot = await createFixtureRoot("dim-monorepo-unavailable-github-output-");
    const output = resolve(outputRoot, "candidate");

    // When
    const result = runBuilder(output, sources);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("GitHub development commit is unavailable: ffffffffffffffffffffffffffffffffffffffff");
    expect(git(outputRoot, ["-C", output, "status"]).status).not.toBe(0);
  });

  it("rejects a partial GitHub history before creating output", async () => {
    // Given
    const sources = await createFixture();
    const github = sources.find(({ name }) => name === "github-development");
    successfulGit(github?.path ?? "", ["config", "remote.origin.promisor", "true"]);
    const outputRoot = await createFixtureRoot("dim-monorepo-partial-github-output-");
    const output = resolve(outputRoot, "candidate");

    // When
    const result = runBuilder(output, sources);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("GitHub development source must contain complete history and blobs");
    expect(git(outputRoot, ["-C", output, "status"]).status).not.toBe(0);
  });
});
