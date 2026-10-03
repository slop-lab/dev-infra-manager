import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoots: string[] = [];
const commit = "1".repeat(40);
const aggregateLock = "lockfileVersion: '9.0'\n";

type Fixture = {
  readonly root: string;
  readonly script: string;
  readonly tools: string;
  readonly versions: string;
};

async function createFixture(prefix = "dim-local-package-identity-"): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  fixtureRoots.push(root);
  const scripts = resolve(root, "verification/scripts");
  const project = resolve(root, "project");
  const tools = resolve(root, "tools");
  const versions = resolve(root, "versions.log");
  await Promise.all([
    mkdir(scripts, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(tools, { recursive: true }),
    mkdir(resolve(root, "core"), { recursive: true })
  ]);
  await writeFile(resolve(root, "core/package.json"), '{"version":"0.8.0"}\n');
  const script = resolve(scripts, "pack-local-packages.bash");
  await copyFile(resolve(workspaceRoot, "verification/scripts/pack-local-packages.bash"), script);
  await copyFile(resolve(workspaceRoot, "verification/scripts/local-build-version.bash"), resolve(scripts, "local-build-version.bash"));
  await writeFile(resolve(project, "pnpm-lock.yaml"), aggregateLock);

  const toolSources: Readonly<Record<string, string>> = {
    git: `#!/usr/bin/env bash
set -euo pipefail
[[ "\${GIT_MASTER:-}" == 1 ]]
operation="$3 $4"
if [[ "$operation" == "rev-parse HEAD" ]]; then
  printf '%s\n' "$DIM_TEST_ROOT_HEAD"
elif [[ "$operation" == "status --porcelain" ]]; then
  if [[ "\${DIM_TEST_STATUS_FAILURE:-}" == 1 ]]; then
    exit 41
  fi
  if [[ "\${DIM_TEST_DIRTY:-}" == 1 ]]; then
    printf ' M package.json\n'
  fi
fi
`,
    node: `#!/usr/bin/env bash
if [[ "$1" == -p ]]; then
  exec ${JSON.stringify(process.execPath)} "$@"
else
  printf '%s\n' "$DIM_LOCAL_BUILD_VERSION" >>"$DIM_TEST_VERSIONS"
fi
`,
    pnpm: `#!/usr/bin/env bash
printf '%s\n' "$DIM_LOCAL_BUILD_VERSION" >>"$DIM_TEST_VERSIONS"
`
  };
  await Promise.all(
    Object.entries(toolSources).map(async ([name, source]) => {
      const path = resolve(tools, name);
      await writeFile(path, source);
      await chmod(path, 0o755);
    })
  );
  return { root, script, tools, versions };
}

function runPack(
  fixture: Fixture,
  head: string,
  dirty = false
): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", [fixture.script, resolve(fixture.root, "packages")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      DIM_TEST_ROOT_HEAD: head,
      DIM_TEST_DIRTY: dirty ? "1" : "",
      DIM_ROOT_REPOSITORY_PATH: resolve(fixture.root, "project"),
      DIM_TEST_VERSIONS: fixture.versions
    }
  });
}

function runVersion(fixture: Fixture, environment: Readonly<Record<string, string>> = {}): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", [resolve(fixture.root, "verification/scripts/local-build-version.bash")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      DIM_TEST_ROOT_HEAD: commit,
      DIM_ROOT_REPOSITORY_PATH: resolve(fixture.root, "project"),
      DIM_TEST_VERSIONS: fixture.versions,
      ...environment
    }
  });
}

function aggregateIdentity(head: string): string {
  return createHash("sha256")
    .update(
      `root=${head}\naggregate-lock-sha256=${createHash("sha256").update(aggregateLock).digest("hex")}\n`
    )
    .digest("hex");
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local package identity", () => {
  it("changes the exact aggregate version when the aggregate root HEAD changes", async () => {
    const fixture = await createFixture();
    const changedCommit = "4".repeat(40);

    const first = runPack(fixture, commit);
    const second = runPack(fixture, changedCommit);
    const versions = (await readFile(fixture.versions, "utf8")).trim().split("\n");

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(versions).toEqual([
      `0.8.0-local-${aggregateIdentity(commit)}`,
      `0.8.0-local-${aggregateIdentity(commit)}`,
      `0.8.0-local-${aggregateIdentity(changedCommit)}`,
      `0.8.0-local-${aggregateIdentity(changedCommit)}`
    ]);
  });

  it("uses the exact same aggregate local version for packages and images", async () => {
    const fixture = await createFixture();

    const packages = runPack(fixture, commit);
    const image = spawnSync("/usr/bin/bash", [resolve(fixture.root, "verification/scripts/local-build-version.bash")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.tools}:/usr/bin:/bin`,
        DIM_TEST_ROOT_HEAD: commit,
        DIM_ROOT_REPOSITORY_PATH: resolve(fixture.root, "project"),
        DIM_TEST_VERSIONS: fixture.versions
      }
    });
    const versions = (await readFile(fixture.versions, "utf8")).trim().split("\n");

    expect(packages.status).toBe(0);
    expect(image.status).toBe(0);
    expect(versions).toEqual([image.stdout.trim(), image.stdout.trim()]);
  });

  it("appends one dirty suffix when the aggregate root is dirty", async () => {
    const fixture = await createFixture();

    const result = runPack(fixture, commit, true);
    const versions = (await readFile(fixture.versions, "utf8")).trim().split("\n");

    expect(result.status).toBe(0);
    expect(versions).toEqual([
      `0.8.0-local-${aggregateIdentity(commit)}-dirty`,
      `0.8.0-local-${aggregateIdentity(commit)}-dirty`
    ]);
  });

  it("stops before package build and pack when the aggregate lock is missing", async () => {
    // Given
    const fixture = await createFixture();
    await rm(resolve(fixture.root, "project/pnpm-lock.yaml"));

    // When
    const result = runPack(fixture, commit);

    // Then
    expect(result.status).not.toBe(0);
    await expect(readFile(fixture.versions, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns no version when repository status inspection fails", async () => {
    // Given
    const fixture = await createFixture();

    // When
    const result = runVersion(fixture, { DIM_TEST_STATUS_FAILURE: "1" });

    // Then
    expect(result.status).toBe(41);
    expect(result.stdout).toBe("");
  });

  it("reads the package version when the repository path contains a quote", async () => {
    // Given
    const fixture = await createFixture("dim-local-package-'identity-");

    // When
    const result = runVersion(fixture);

    // Then
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`0.8.0-local-${aggregateIdentity(commit)}`);
  });

  it("builds release and aggregate-local workspace images before local-tag consumers", async () => {
    // Given
    const recipes = await readFile(resolve(workspaceRoot, "verification/verify.just"), "utf8");
    const workspaceRuntime = recipes.slice(
      recipes.indexOf("workspace-runtime:"),
      recipes.indexOf("# Requires Docker and network access")
    );

    // When
    const releaseBuild = workspaceRuntime.indexOf("just build-workspace-image");
    const localBuild = workspaceRuntime.indexOf("just build-local-workspace-image");
    const localTagConsumer = workspaceRuntime.indexOf("container-inner-docker-smoke.bash");

    // Then
    expect(releaseBuild).toBeGreaterThan(-1);
    expect(localBuild).toBeGreaterThan(releaseBuild);
    expect(localBuild).toBeLessThan(localTagConsumer);
    expect(workspaceRuntime).toContain(
      "    just build-workspace-image\n    just build-local-workspace-image\n    cd .. && bash verification/scripts/container-inner-docker-smoke.bash"
    );
  });
});
