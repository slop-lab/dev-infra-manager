import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoots: string[] = [];

type RealGitFixture = {
  readonly root: string;
  readonly tools: string;
  readonly log: string;
  readonly selectedCommit: string;
};

function git(root: string, ...arguments_: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/git", ["-C", root, ...arguments_], { encoding: "utf8" });
}

async function createRealGitFixture(): Promise<RealGitFixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-source-real-git-"));
  fixtureRoots.push(root);
  const scripts = resolve(root, "scripts");
  const tools = resolve(root, "tools");
  const log = resolve(root, "invocations.log");
  await Promise.all([mkdir(scripts), mkdir(tools)]);
  await copyFile(resolve(workspaceRoot, "scripts/pack-source-build.bash"), resolve(scripts, "pack-source-build.bash"));
  await writeFile(resolve(scripts, "pack-local-packages.mjs"), "");
  await writeFile(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const packageDirectories = [
    "core/packages/core",
    "core/packages/cli",
    "core/packages/installer",
    "core/packages/controller-proxy",
    "core/packages/contracts/external-url",
    "plugin-dns-cloudflare",
    "plugin-external-urls"
  ] as const;
  await Promise.all(
    packageDirectories.map(async (directory) => {
      await mkdir(resolve(root, directory), { recursive: true });
      await writeFile(resolve(root, directory, "package.json"), '{"name":"fixture","version":"0.8.0"}\n');
    })
  );
  await writeFile(resolve(root, "core/package.json"), '{"name":"core-fixture","version":"0.8.0"}\n');
  await writeFile(resolve(root, "core/packages/core/source-marker"), "selected-commit\n");

  const toolsSource = {
    docker: "#!/usr/bin/env bash\nprintf 'sha256:%064d\\n' 1\n",
    node: [
      "#!/usr/bin/env bash",
      "if [[ \"$1\" == '-p' ]]; then printf '0.8.0\\n'; exit 0; fi",
      "printf 'node version=%s\\n' \"$DIM_LOCAL_BUILD_VERSION\" >>\"$DIM_INVOCATIONS\"",
      "cp \"$2/core/packages/core/source-marker\" \"$3/source-marker\""
    ].join("\n"),
    pnpm: "#!/usr/bin/env bash\nprintf 'pnpm %s\\n' \"$*\" >>\"$DIM_INVOCATIONS\"\nexit \"${DIM_PNPM_FAILURE:-0}\"\n"
  } as const;
  await Promise.all(
    Object.entries(toolsSource).map(async ([name, source]) => {
      const path = resolve(tools, name);
      await writeFile(path, `${source}\n`);
      await chmod(path, 0o755);
    })
  );

  expect(git(root, "init", "--quiet").status).toBe(0);
  expect(git(root, "config", "user.name", "DIM Test").status).toBe(0);
  expect(git(root, "config", "user.email", "dim-test@example.invalid").status).toBe(0);
  expect(git(root, "add", ".").status).toBe(0);
  expect(git(root, "commit", "--quiet", "-m", "selected source").status).toBe(0);
  return { root, tools, log, selectedCommit: git(root, "rev-parse", "HEAD").stdout.trim() };
}

function runPack(fixture: RealGitFixture, commit: string, output: string): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", [resolve(fixture.root, "scripts/pack-source-build.bash"), output], {
    encoding: "utf8",
    env: {
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      DIM_INVOCATIONS: fixture.log,
      DIM_SOURCE_ROOT_COMMIT: commit
    }
  });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("real Git local source build safety", () => {
  it("archives the selected commit bytes when a replacement ref exists", async () => {
    // Given
    const fixture = await createRealGitFixture();
    await writeFile(resolve(fixture.root, "core/packages/core/source-marker"), "replacement-commit\n");
    expect(git(fixture.root, "add", ".").status).toBe(0);
    expect(git(fixture.root, "commit", "--quiet", "-m", "replacement source").status).toBe(0);
    const replacementCommit = git(fixture.root, "rev-parse", "HEAD").stdout.trim();
    expect(git(fixture.root, "replace", fixture.selectedCommit, replacementCommit).status).toBe(0);
    const output = resolve(fixture.root, "candidate");

    // When
    const result = runPack(fixture, fixture.selectedCommit, output);

    // Then
    expect(result.status).toBe(0);
    expect(await readFile(resolve(output, "source-marker"), "utf8")).toBe("selected-commit\n");
    expect(await readFile(resolve(output, ".dim-source-state"), "utf8")).toContain(`root=${fixture.selectedCommit}\n`);
  });

  it("rejects a tree object before dependency installation or publication", async () => {
    // Given
    const fixture = await createRealGitFixture();
    const tree = git(fixture.root, "rev-parse", `${fixture.selectedCommit}^{tree}`).stdout.trim();
    const output = resolve(fixture.root, "candidate");

    // When
    const result = runPack(fixture, tree, output);

    // Then
    expect(result.status).not.toBe(0);
    await expect(readFile(fixture.log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(output, "packages.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the selected commit lock when the working tree lock drifts", async () => {
    // Given
    const fixture = await createRealGitFixture();
    const committedLock = "lockfileVersion: '9.0'\n";
    await writeFile(resolve(fixture.root, "pnpm-lock.yaml"), `${committedLock}settings:\n  autoInstallPeers: false\n`);
    const output = resolve(fixture.root, "candidate");

    // When
    const result = runPack(fixture, fixture.selectedCommit, output);

    // Then
    expect(result.status).toBe(0);
    const state = await readFile(resolve(output, ".dim-source-state"), "utf8");
    expect(state).toContain(`aggregate-lock-sha256=${createHash("sha256").update(committedLock).digest("hex")}\n`);
  });

  it("changes aggregate identity when a new commit changes the lock", async () => {
    // Given
    const fixture = await createRealGitFixture();
    const firstOutput = resolve(fixture.root, "candidate-a");
    expect(runPack(fixture, fixture.selectedCommit, firstOutput).status).toBe(0);
    const firstVersion = (await readFile(fixture.log, "utf8")).match(/version=([^\n]+)/)?.[1];
    await writeFile(fixture.log, "");
    await writeFile(resolve(fixture.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\n");
    expect(git(fixture.root, "add", "pnpm-lock.yaml").status).toBe(0);
    expect(git(fixture.root, "commit", "--quiet", "-m", "change lock").status).toBe(0);
    const changedCommit = git(fixture.root, "rev-parse", "HEAD").stdout.trim();

    // When
    const result = runPack(fixture, changedCommit, resolve(fixture.root, "candidate-b"));
    const secondVersion = (await readFile(fixture.log, "utf8")).match(/version=([^\n]+)/)?.[1];

    // Then
    expect(result.status).toBe(0);
    expect(firstVersion).toBeDefined();
    expect(secondVersion).toBeDefined();
    expect(secondVersion).not.toBe(firstVersion);
  });

  it.each(["production-source", "output"])("rejects a symlinked %s path without changing its target", async (pathKind) => {
    // Given
    const fixture = await createRealGitFixture();
    const target = resolve(fixture.root, "core/packages/core");
    const trackedManifest = await readFile(resolve(target, "package.json"), "utf8");
    const output = resolve(fixture.root, "candidate");
    if (pathKind === "production-source") {
      await mkdir(resolve(fixture.root, ".local"));
      await symlink(target, resolve(fixture.root, ".local/production-source"));
    } else {
      await symlink(target, output);
    }

    // When
    const result = runPack(fixture, fixture.selectedCommit, output);

    // Then
    expect(result.status).not.toBe(0);
    expect(await readFile(resolve(target, "package.json"), "utf8")).toBe(trackedManifest);
    expect(git(fixture.root, "status", "--short").stdout).not.toContain("package.json");
  });

  it("computes identical readiness for identical bundles at different paths", async () => {
    // Given
    const fixture = await createRealGitFixture();
    const stateScript = resolve(fixture.root, "scripts/local-preparation-state.bash");
    await copyFile(resolve(workspaceRoot, "scripts/local-preparation-state.bash"), stateScript);
    const firstPackages = resolve(fixture.root, "first-packages");
    const secondPackages = resolve(fixture.root, "second-packages");
    await Promise.all([mkdir(firstPackages), mkdir(secondPackages)]);
    for (const packageRoot of [firstPackages, secondPackages]) {
      await writeFile(resolve(packageRoot, "packages.json"), "{}\n");
      await writeFile(resolve(packageRoot, "package.tgz"), "package bytes\n");
      await writeFile(resolve(packageRoot, ".dim-source-state"), `root=${fixture.selectedCommit}\n`);
    }
    const environment = {
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      DIM_LOCAL_IMAGE_INSPECT_REF: "temporary-image",
      DIM_LOCAL_IMAGE_RECORD_REF: "final-image"
    } as const;

    // When
    const first = spawnSync("/usr/bin/bash", [stateScript], {
      encoding: "utf8",
      env: { ...environment, DIM_LOCAL_PACKAGE_ROOT: firstPackages }
    });
    const second = spawnSync("/usr/bin/bash", [stateScript], {
      encoding: "utf8",
      env: { ...environment, DIM_LOCAL_PACKAGE_ROOT: secondPackages }
    });

    // Then
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

});
