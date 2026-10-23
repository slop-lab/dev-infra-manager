import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
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
  await writeFile(resolve(scripts, "pack-local-packages.ts"), `
import {copyFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
const [,,source,output]=process.argv;
if (!source || !output) throw new Error("source and output required");
copyFileSync(join(source,"packages/host/core/source-marker"),join(output,"source-marker"));
writeFileSync(join(output,"packer-marker"),"selected-packer\\n");
`);
  await writeFile(resolve(root, "LICENSE"), "fixture license\n");
  await copyFile(resolve(workspaceRoot, "tsconfig.base.json"), resolve(root, "tsconfig.base.json"));
  await copyFile(resolve(workspaceRoot, "tsconfig.source.json"), resolve(root, "tsconfig.source.json"));
  await writeFile(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const packageDirectories = [
    "packages/host/core",
    "packages/control-plane/core",
    "packages/contracts/ci",
    "packages/contracts/execution",
    "packages/git-review-tracing/engine",
    "packages/git-review-tracing/runtimes/node",
    "packages/host/plugins/git-review-tracing-node",
    "packages/control-plane/plugins/git-review-tracing-scheduled",
    "packages/control-plane/plugins/git-review-tracing",
    "packages/control-plane/plugins/git-review-tracing-node",
    "packages/control-plane/admin",
    "packages/control-plane/plugins/execution-scheduler",
    "packages/host/plugins/native-git",
    "packages/host/plugins/execution-worker",
    "packages/cli/core",
    "packages/installer",
    "packages/control-plane/plugins/git-repositories",
    "packages/control-plane/plugins/git-sync",
    "packages/web/core",
    "packages/contracts/external-url",
    "packages/host/plugins/dns-cloudflare",
    "packages/host/plugins/external-urls",
    "packages/host/plugins/tailscale",
    "packages/host/plugins/mirrors",
    "packages/host/plugins/cache-server",
    "packages/control-plane/plugins/ci-workflows",
    "packages/host/plugins/llm-router",
    "packages/control-plane/plugins/llm-router",
    "packages/host/plugins/vm",
    "packages/host/plugins/kvm",
    "packages/host/plugins/workspace-check",
    "packages/host/plugins/agent-tools",
    "packages/host/plugins/tunnels"
  ] as const;
  await Promise.all(
    packageDirectories.map(async (directory) => {
      await mkdir(resolve(root, directory), { recursive: true });
      await writeFile(resolve(root, directory, "package.json"), '{"name":"fixture","version":"0.8.0"}\n');
    })
  );
  await writeFile(resolve(root, "package.json"), '{"name":"core-fixture","version":"0.8.0"}\n');
  await writeFile(resolve(root, "packages/host/core/source-marker"), "selected-commit\n");
  // Compile the actual source/build config inheritance from archived bytes.
  await copyFile(resolve(workspaceRoot, "packages/host/core/tsconfig.json"), resolve(root, "packages/host/core/tsconfig.json"));
  await copyFile(resolve(workspaceRoot, "packages/host/core/tsconfig.build.json"), resolve(root, "packages/host/core/tsconfig.build.json"));
  await mkdir(resolve(root, "packages/host/core/src"));
  await writeFile(resolve(root, "packages/host/core/src/index.ts"), "export const archived: string = 'selected source';\n");

  await mkdir(resolve(root, "scripts/packages"), { recursive: true });
  await writeFile(resolve(root, "scripts/packages/.fixture"), "fixture\n");
  const toolsSource = {
    docker: "#!/usr/bin/env bash\nprintf 'sha256:%064d\\n' 1\n",
    node: [
      "#!/usr/bin/env bash",
      `if [[ "$1" == '-p' ]]; then exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"; fi`,
      "printf 'node version=%s\\n' \"$DIM_LOCAL_BUILD_VERSION\" >>\"$DIM_INVOCATIONS\"",
      `exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"`
    ].join("\n"),
    pnpm: [
      "#!/usr/bin/env bash",
      "printf 'pnpm %s\\n' \"$*\" >>\"$DIM_INVOCATIONS\"",
      "[[ \"${DIM_PNPM_FAILURE:-0}\" == 0 ]] || exit \"$DIM_PNPM_FAILURE\"",
      `if [[ "$3" == '--recursive' ]]; then exec '${process.execPath.replaceAll("'", "'\\''")}' '${resolve(workspaceRoot, "tests/node_modules/typescript/bin/tsc").replaceAll("'", "'\\''")}' -p "$2/packages/host/core/tsconfig.build.json"; fi`
    ].join("\n")
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

function runPack(fixture: RealGitFixture, commit: string, output: string, sourceRoot?: string): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", [resolve(fixture.root, "scripts/pack-source-build.bash"), output], {
    encoding: "utf8",
    env: {
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      DIM_INVOCATIONS: fixture.log,
      DIM_SOURCE_ROOT_COMMIT: commit,
      ...(sourceRoot === undefined ? {} : { DIM_SOURCE_BUILD_ROOT: sourceRoot })
    }
  });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("real Git local source build safety", () => {
  it("archives selected commit bytes through a quoted staging path when a replacement ref exists", async () => {
    // Given
    const fixture = await createRealGitFixture();
    await writeFile(resolve(fixture.root, "packages/host/core/source-marker"), "replacement-commit\n");
    expect(git(fixture.root, "add", ".").status).toBe(0);
    expect(git(fixture.root, "commit", "--quiet", "-m", "replacement source").status).toBe(0);
    const replacementCommit = git(fixture.root, "rev-parse", "HEAD").stdout.trim();
    expect(git(fixture.root, "replace", fixture.selectedCommit, replacementCommit).status).toBe(0);
    const output = resolve(fixture.root, "candidate");
    // The checkout helper is deliberately different from the selected commit.
    await writeFile(resolve(fixture.root, "scripts/pack-local-packages.ts"), "throw new Error('unreviewed checkout packer executed');\n");

    // When
    const result = runPack(fixture, fixture.selectedCommit, output, resolve(fixture.root, "quoted ' source staging"));

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(resolve(fixture.root, "quoted ' source staging/packages/host/core/dist/index.js"), "utf8")).toContain("selected source");
    expect(await readFile(resolve(output, "source-marker"), "utf8")).toBe("selected-commit\n");
    expect(await readFile(resolve(output, "packer-marker"), "utf8")).toBe("selected-packer\n");
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
    const target = resolve(fixture.root, "packages/host/core");
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
    for (const helper of ["local-control-plane/images.ts", "local-uninstall/command.ts", "local-uninstall/files.ts"]) {
      const target = resolve(fixture.root, "scripts", helper);
      await mkdir(resolve(target, ".."), { recursive: true });
      await copyFile(resolve(workspaceRoot, "scripts", helper), target);
    }
    const firstPackages = resolve(fixture.root, "first-packages");
    const secondPackages = resolve(fixture.root, "second-packages");
    await Promise.all([mkdir(firstPackages), mkdir(secondPackages)]);
    for (const packageRoot of [firstPackages, secondPackages]) {
      await writeFile(resolve(packageRoot, "packages.json"), "{}\n");
      await writeFile(resolve(packageRoot, "package.tgz"), "package bytes\n");
      await writeFile(resolve(packageRoot, ".dim-source-state"), `root=${fixture.selectedCommit}\n`);
      await writeFile(resolve(packageRoot, "control-plane-images.json"), JSON.stringify({ schemaVersion: 1,
        "native-git": { tag: "dim-local-native-git:test", id: `sha256:${"0".repeat(63)}1` },
        execution: { tag: "dim-local-execution:test", id: `sha256:${"0".repeat(63)}1` } }));
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
