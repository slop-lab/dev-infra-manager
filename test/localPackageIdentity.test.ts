import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const fixtureRoots: string[] = [];
const repositories = ["core", "plugin-dns-cloudflare", "plugin-external-urls"] as const;
const commits = {
  core: "1".repeat(40),
  "plugin-dns-cloudflare": "2".repeat(40),
  "plugin-external-urls": "3".repeat(40)
} as const;

type Fixture = {
  readonly root: string;
  readonly script: string;
  readonly tools: string;
  readonly versions: string;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(resolve(tmpdir(), "dim-local-package-identity-"));
  fixtureRoots.push(root);
  const scripts = resolve(root, "verification/scripts");
  const tools = resolve(root, "tools");
  const versions = resolve(root, "versions.log");
  await Promise.all([
    mkdir(scripts, { recursive: true }),
    mkdir(tools, { recursive: true }),
    ...repositories.map((repository) => mkdir(resolve(root, repository), { recursive: true }))
  ]);
  const script = resolve(scripts, "pack-local-packages.bash");
  await copyFile(resolve(workspaceRoot, "verification/scripts/pack-local-packages.bash"), script);

  const toolSources: Readonly<Record<string, string>> = {
    git: `#!/usr/bin/env bash
set -euo pipefail
[[ "\${GIT_MASTER:-}" == 1 ]]
repository="$2"
operation="$3 $4"
if [[ "$operation" == "rev-parse HEAD" ]]; then
  case "$repository" in
    core) printf '%s\n' "$DIM_TEST_CORE_HEAD" ;;
    plugin-dns-cloudflare) printf '%s\n' "$DIM_TEST_DNS_HEAD" ;;
    plugin-external-urls) printf '%s\n' "$DIM_TEST_EXTERNAL_HEAD" ;;
  esac
elif [[ "$operation" == "status --porcelain" && "$repository" == "\${DIM_TEST_DIRTY_REPOSITORY:-}" ]]; then
  printf ' M package.json\n'
fi
`,
    node: `#!/usr/bin/env bash
if [[ "$1" == -p ]]; then
  printf '0.8.0\n'
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
  heads: Readonly<Record<(typeof repositories)[number], string>>,
  dirtyRepository = ""
): SpawnSyncReturns<string> {
  return spawnSync("/usr/bin/bash", [fixture.script, resolve(fixture.root, "packages")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.tools}:/usr/bin:/bin`,
      DIM_TEST_CORE_HEAD: heads.core,
      DIM_TEST_DNS_HEAD: heads["plugin-dns-cloudflare"],
      DIM_TEST_EXTERNAL_HEAD: heads["plugin-external-urls"],
      DIM_TEST_DIRTY_REPOSITORY: dirtyRepository,
      DIM_TEST_VERSIONS: fixture.versions
    }
  });
}

function aggregateIdentity(heads: Readonly<Record<(typeof repositories)[number], string>>): string {
  return createHash("sha256")
    .update(repositories.map((repository) => `${repository}=${heads[repository]}\n`).join(""))
    .digest("hex");
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local package identity", () => {
  it("changes the exact aggregate version when only a plugin HEAD changes", async () => {
    const fixture = await createFixture();
    const changedHeads = { ...commits, "plugin-external-urls": "4".repeat(40) };

    const first = runPack(fixture, commits);
    const second = runPack(fixture, changedHeads);
    const versions = (await readFile(fixture.versions, "utf8")).trim().split("\n");

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(versions).toEqual([
      `0.8.0-local-${aggregateIdentity(commits)}`,
      `0.8.0-local-${aggregateIdentity(commits)}`,
      `0.8.0-local-${aggregateIdentity(changedHeads)}`,
      `0.8.0-local-${aggregateIdentity(changedHeads)}`
    ]);
  });

  it.each(repositories)("appends one dirty suffix when %s is dirty", async (dirtyRepository) => {
    const fixture = await createFixture();

    const result = runPack(fixture, commits, dirtyRepository);
    const versions = (await readFile(fixture.versions, "utf8")).trim().split("\n");

    expect(result.status).toBe(0);
    expect(versions).toEqual([
      `0.8.0-local-${aggregateIdentity(commits)}-dirty`,
      `0.8.0-local-${aggregateIdentity(commits)}-dirty`
    ]);
  });
});
