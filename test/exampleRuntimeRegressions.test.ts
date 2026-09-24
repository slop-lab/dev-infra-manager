import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const richExamples = ["multi-repository", "full-development-flow"] as const;
const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rich example runtime regressions", () => {
  it.each(richExamples)("stops and restarts the inner agent while archiving %s", async (example) => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-home-archive-test-"));
    fixtureRoots.push(root);
    const tools = resolve(root, "tools");
    const calls = resolve(root, "docker.calls");
    await mkdir(tools);
    await writeFile(resolve(tools, "docker"), `#!/usr/bin/env sh
set -eu
printf '%s\n' "$*" >>"$DIM_TEST_DOCKER_CALLS"
case "$1 $2" in
  'container ls') printf 'outer-agent-dind\n' ;;
  'volume ls') printf 'agent-home-volume\n' ;;
  'inspect --format') printf 'agent-dind-image\n' ;;
  'exec outer-agent-dind')
    if [ "$3 $4 \${5:-}" = 'docker inspect --format' ]; then printf 'true\n'; fi
    ;;
  'run --rm') printf 'archive-bytes' ;;
esac
`);
    await chmod(resolve(tools, "docker"), 0o755);

    const result = spawnSync(
      "/usr/bin/sh",
      [resolve(workspaceRoot, "examples/projects", example, "repos/root/.dim/home-archive.sh"), "backup"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          COMPOSE_PROJECT_NAME: "dim-project",
          DIM_TEST_DOCKER_CALLS: calls,
          PATH: `${tools}:/usr/bin:/bin`
        }
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("archive-bytes");
    const invocations = await readFile(calls, "utf8");
    expect(invocations).toContain("exec outer-agent-dind dim-agent-dind stop");
    expect(invocations).toContain("exec outer-agent-dind dim-agent-dind start");
    expect(invocations).not.toContain("stop outer-agent-dind");
  });

  it("publishes the complete local package closure in dependency order", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dim-package-closure-test-"));
    fixtureRoots.push(root);
    const packageNames = [
      "dim-contracts-external-url",
      "dim-controller-proxy",
      "dim-core",
      "plugin-dns-cloudflare",
      "plugin-external-urls",
      "dim-cli",
      "dim-installer"
    ];
    await Promise.all(packageNames.map((name) => writeFile(resolve(root, `${name}-0.9.0-local-test.tgz`), "")));
    const helper = resolve(workspaceRoot, "verification/scripts/lib/example-dim-install.bash");
    const script = `set -euo pipefail
source "$1"
dim_publish_to_local_registry() { printf '%s\n' "$@"; }
dim_publish_example_packages "$2"
`;

    const result = spawnSync("/usr/bin/bash", ["-c", script, "bash", helper, root], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n").map((file) => file.slice(file.lastIndexOf("/") + 1))).toEqual(
      packageNames.map((name) => `${name}-0.9.0-local-test.tgz`)
    );
  });
});
